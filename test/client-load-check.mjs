// Load client.js with mocked window/React and call the plugin's apply().
// Catches client-half apply errors without a browser.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../client.js', import.meta.url))
const source = readFileSync(file, 'utf8')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      plugin = module.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require ${name}`)
      })
    },
  },
}
globalThis.document = { baseURI: 'http://127.0.0.1:58287/' }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.Notification = undefined
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: {} }) })
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

new Function(source)()

const registrations = []
const ctx = {
  effect(callback, label) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    register(ns, locale, dict) {
      if (typeof locale === 'object') throw new Error('unexpected register form')
      return () => {}
    },
    bind: () => (key) => key,
    subscribe: () => () => {},
    getLocale: () => ({ active: 'en' }),
  },
  slots: {
    inject(key, callback) {
      registrations.push(['inject', key])
      const disposer = callback()
      return () => {}
    },
    register(options, component) {
      registrations.push(['register', options.name, options.id || options.key || ''])
      if (typeof component !== 'function') throw new Error(`component for ${options.name} is not a function`)
      return () => {}
    },
  },
  uiWorkspace: { openSession() {} },
}

try {
  plugin.apply(ctx)
  console.log('CLIENT APPLY OK')
  console.log(registrations.map((entry) => entry.join(' ')).join('\n'))
  console.log('inject declared:', plugin.inject)
} catch (error) {
  console.error('CLIENT APPLY FAILED:', error && error.stack ? error.stack : error)
  process.exitCode = 1
}
