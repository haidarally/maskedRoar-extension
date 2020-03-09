const gulp = require('gulp')
const watch = require('gulp-watch')
const source = require('vinyl-source-stream')
const buffer = require('vinyl-buffer')
const EventEmitter = require('events')
const log = require('fancy-log')
const browserify = require('browserify')
const envify = require('envify/custom')
const sourcemaps = require('gulp-sourcemaps')
const terser = require('gulp-terser-js')
const rename = require('gulp-rename')
const pify = require('pify')
const endOfStream = pify(require('end-of-stream'))
const labeledStreamSplicer = require('labeled-stream-splicer').obj
const createLavamoatPacker = require('lavamoat-browserify/src/createCustomPack')
const lavamoatArgs = require('lavamoat-browserify').args
const { createTask, composeParallel, composeSeries, runInChildProcess } = require('./task')
const { promises: fs } = require('fs')
// const sesify = require('sesify')
// const { makeStringTransform } = require('browserify-transform-tools')

module.exports = createScriptTasks


function createScriptTasks ({ browserPlatforms, livereload }) {

  const prod = createBundleTasks('prod')
  const dev = createBundleTasks('dev', { devMode: true })
  const testDev = createBundleTasks('testDev', { test: true, devMode: true, livereload })
  const test = createBundleTasks('test', { test: true })
  const lavamoat = createLavamoatTask('lavamoat:dashboard')

  return { prod, dev, testDev, test, lavamoat }


  function createBundleTasks (label, { devMode, test, livereload } = {}) {
    const primaryBundlesTask = createTask(`scripts:${label}:factor`, createFactorBundles({ test, devMode }))
    const contentscriptTask = createTask(`scripts:${label}:contentscript`, createBuildContentscriptTask({ test, devMode }))
    return createTask(`scripts:${label}`, composeParallel(...[
      runInChildProcess(primaryBundlesTask),
      runInChildProcess(contentscriptTask),
      devMode && initiateLiveReload({ livereload }),
    ].filter(Boolean)))
  }

  // task for initiating livereload
  function initiateLiveReload ({ livereload }) {
    return () => {
      // trigger live reload when the bundles are updated
      // this is not ideal, but overcomes the limitations:
      // - run from the main process (not child process tasks)
      // - after the first build has completed (thus the timeout)
      // - build tasks never "complete" when run with livereload + child process
      setTimeout(() => {
        watch('./dist/*/*.js', (event) => {
          livereload.changed(event.path)
        })
      }, 75e3)
    }
  }

  function createBuildContentscriptTask ({ devMode, testing } = {}) {
    // inpage must be built first so it can be inserted into contentscript
    const inpage = 'inpage'
    const contentscript = 'contentscript'
    return composeSeries(
      createNormalBundle({
        // label: inpage,
        destName: `${inpage}.js`,
        srcPath: `./app/scripts/${inpage}.js`,
        devMode,
        testing,
        watchify: false,
      }),
      createNormalBundle({
        // label: contentscript,
        destName: `${contentscript}.js`,
        srcPath: `./app/scripts/${contentscript}.js`,
        devMode,
        testing,
        watchify: devMode,
      })
    )
  }

  function createFactorBundles ({ devMode, test } = {}) {
    return async function buildFactor () {
      // create bundler setup and apply defaults
      const { bundlerOpts, events } = createBundlerSetup()
      setupBundlerDefaults({ bundlerOpts, events, devMode, test, watchify: devMode })

      // add factor-bundle specific options
      Object.assign(bundlerOpts, {
        // ui + background, bify-package-factor will split into separate bundles
        entries: ['app/scripts/ui.js', 'app/scripts/background.js'],
        // dedupe breaks under bundle factoring
        dedupe: false,
        plugin: [
          ...bundlerOpts.plugin,
          // factor code into multiple bundles and emit as vinyl file objects
          'bify-package-factor',
        ],
      })

      // instrument build pipeline
      events.on('pipeline', (pipeline) => {
        // setup bundle destination
        browserPlatforms.forEach((platform) => {
          const dest = `./dist/${platform}`
          pipeline.get('dest').push(rename((path) => {
            // remove relative source directory
            path.dirname = '.'
          }))
          pipeline.get('dest').push(gulp.dest(dest))
        })
      })

      await bundleIt({ bundlerOpts, events })
    }
  }

  function createNormalBundle ({ destName, srcPath, devMode, test, watchify }) {
    return async function () {

      // create bundler setup and apply defaults
      const { bundlerOpts, events } = createBundlerSetup()
      setupBundlerDefaults({ bundlerOpts, events, devMode, test, watchify })

      // set bundle entry file
      bundlerOpts.entries = [srcPath]

      // instrument pipeline
      events.on('pipeline', (pipeline) => {
        // convert bundle stream to gulp vinyl stream
        pipeline.get('vinyl').push(
          source(destName)
        )
        // initialize source maps, requires files to be buffered
        pipeline.get('sourcemaps:init').push(buffer())
        pipeline.get('sourcemaps:init').push(
          sourcemaps.init({ loadMaps: true })
        )
        // setup bundle destination
        browserPlatforms.forEach((platform) => {
          const dest = `./dist/${platform}/`
          pipeline.get('dest').push(gulp.dest(dest))
        })
      })

      await bundleIt({ bundlerOpts, events })
    }
  }

  function createLavamoatTask (label) {
    return createTask(label, async function () {
      // create bundler setup and apply defaults
      const { bundlerOpts, events } = createBundlerSetup()
      setupBundlerDefaults({ bundlerOpts, events })

      // add factor-bundle specific options
      Object.assign(bundlerOpts, {
        // add recommended lavamoat args
        ...lavamoatArgs,
        // ui + background, bify-package-factor will split into separate bundles
        entries: ['app/scripts/ui.js', 'app/scripts/background.js'],
        // dedupe breaks under bundle factoring
        dedupe: false,
        plugin: [
          ...bundlerOpts.plugin,
          // add lavamoat for global usage detection
          ['lavamoat-browserify', {
            config: './dist/lavamoat/lavamoat-config.json',
            writeAutoConfig: true,
          }],
          // factor code into multiple bundles and emit as vinyl file objects
          ['bify-package-factor', {
            createPacker: () => {
              return createLavamoatPacker({
                raw: true,
                config: {},
                includePrelude: false,
              })
            },
          }],
          // record dep graph across factored bundles
          ['deps-dump', {
            filename: `./dist/lavamoat/deps.json`,
          }],
        ],
      })

      // we dont add a destination for the build pipeline
      // because we ignore the bundle output

      // record dependencies used in bundle
      await fs.mkdir('./dist/lavamoat', { recursive: true })
      await bundleIt({ bundlerOpts, events })
    })
  }

}

function createBundlerSetup () {
  const events = new EventEmitter()
  const bundlerOpts = {
    entries: [],
    transform: [],
    plugin: [],
  }
  return { bundlerOpts, events }
}

function setupBundlerDefaults ({ bundlerOpts, events, devMode, test, watchify }) {
  Object.assign(bundlerOpts, {
    // source transforms
    transform: [
      // transpile top-level code
      'babelify',
      // transpile specified dependencies using the object spread/rest operator
      // because it is incompatible with `esprima`, which is used by `envify`
      // See https://github.com/jquery/esprima/issues/1927
      ['babelify', {
        only: [
          './**/node_modules/libp2p',
        ],
        global: true,
        plugins: ['@babel/plugin-proposal-object-rest-spread'],
      }],
      // inline `fs.readFileSync` files
      'brfs',
      // inject environment variables
      [envify({
        METAMASK_DEBUG: devMode,
        METAMASK_ENVIRONMENT: getEnvironment({ devMode }),
        NODE_ENV: devMode ? 'development' : 'production',
        IN_TEST: test ? 'true' : false,
        PUBNUB_SUB_KEY: process.env.PUBNUB_SUB_KEY || '',
        PUBNUB_PUB_KEY: process.env.PUBNUB_PUB_KEY || '',
      }), {
        global: true,
      }],
    ],
    // use filepath for moduleIds, easier to determine origin file
    fullPaths: devMode,
    // for sourcemaps
    debug: true,
  })

  // setup watchify
  if (watchify) {
    setupWatchify({ bundlerOpts, events })
  }

  // instrument pipeline
  events.on('pipeline', (pipeline) => {

    // setup minify
    if (!devMode) {
      pipeline.get('minify').push(buffer())
      pipeline.get('minify').push(terser({
        mangle: {
          reserved: [ 'MetamaskInpageProvider' ],
        },
      }))
    }

    // write sourcemaps
    if (devMode) {
      // Use inline source maps for development due to Chrome DevTools bug
      // https://bugs.chromium.org/p/chromium/issues/detail?id=931675
      pipeline.get('sourcemaps:write').push(sourcemaps.write())
    } else {
      pipeline.get('sourcemaps:write').push(sourcemaps.write('../sourcemaps'))
    }

  })
}

function bundleIt ({ bundlerOpts, events }) {
  const bundler = browserify(bundlerOpts)
  // output build logs to terminal
  bundler.on('log', log)
  // forward update event (used by watchify)
  bundler.on('update', performBundle)
  return performBundle()

  async function performBundle () {
    const pipeline = labeledStreamSplicer([
      'bundler', [],
      'vinyl', [],
      'sourcemaps:init', [],
      'minify', [],
      'sourcemaps:write', [],
      'dest', [],
    ])
    const bundleStream = bundler.bundle()
    // trigger build pipeline instrumentations
    events.emit('pipeline', pipeline, bundleStream)
    // start bundle, send into pipeline
    bundleStream.pipe(pipeline)
    // nothing will consume pipeline, so let it flow
    pipeline.resume()
    await endOfStream(pipeline)
  }
}

function setupWatchify ({ bundlerOpts, events }) {
  // add plugin to options
  Object.assign(bundlerOpts, {
    plugin: [
      ...bundlerOpts.plugin,
      'watchify',
    ],
    // required by watchify
    cache: {},
    packageCache: {},
  })
  // instrument pipeline
  events.on('pipeline', (_, bundleStream) => {
    // handle build error to avoid breaking build process
    bundleStream.on('error', (err) => {
      beep()
      console.warn(err.stack)
    })
  })
}

function beep () {
  process.stdout.write('\x07')
}

function getEnvironment ({ devMode, test }) {
  // get environment slug
  if (devMode) {
    return 'development'
  } else if (test) {
    return 'testing'
  } else if (process.env.CIRCLE_BRANCH === 'master') {
    return 'production'
  } else if (/^Version-v(\d+)[.](\d+)[.](\d+)/.test(process.env.CIRCLE_BRANCH)) {
    return 'release-candidate'
  } else if (process.env.CIRCLE_BRANCH === 'develop') {
    return 'staging'
  } else if (process.env.CIRCLE_PULL_REQUEST) {
    return 'pull-request'
  } else {
    return 'other'
  }
}