import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

for (const locale of ['zh', 'en']) {
  const file = join(root, 'locale', `${locale}.json`)
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const parsed = JSON.parse(text)
  const meta = parsed && parsed.meta ? parsed.meta : null
  assert.ok(meta && typeof meta === 'object', `${locale}.json has a meta object`)
  for (const key of ['title', 'description']) {
    assert.equal(typeof meta[key], 'string', `${locale}.json meta.${key} is a string`)
    assert.ok(meta[key].trim().length > 0, `${locale}.json meta.${key} is not empty`)
  }
  // A description that mentions the schedule must mention the real curve.
  assert.match(meta.description, /30 ?分钟|30m/u, `${locale}.json describes the 30-minute first rung`)
  console.log(`PASS locale: ${locale}.json is valid JSON with a complete meta block`)
}
