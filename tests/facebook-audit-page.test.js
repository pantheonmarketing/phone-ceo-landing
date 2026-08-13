const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'facebook-audit.html'), 'utf8')

test('public audit form uses the approved dependency-free light design', () => {
  assert.match(page, /--canvas:\s*#f7f8f4/i)
  assert.match(page, /--surface:\s*#fff(?:fff)?/i)
  assert.match(page, /--ink:\s*#101a2f/i)
  assert.match(page, /--orange:\s*#ff6238/i)
  assert.match(page, /One buyer question only/)
  assert.match(page, /Authorized test/)
  assert.match(page, /Real timestamps/)
  assert.match(page, /No fake scores/)
  assert.doesNotMatch(page, /cdn\.tailwindcss\.com|iconify/i)
})

test('light redesign preserves the authorized audit form and result behavior', () => {
  for (const id of [
    'audit-form',
    'businessName',
    'pageUrl',
    'customerQuestion',
    'authorized',
    'submit',
    'error',
    'result',
    'result-id',
    'result-link',
    'result-warning'
  ]) {
    assert.match(page, new RegExp(`id=["']${id}["']`))
  }

  assert.match(page, /I own this Page or have permission to run one response-time test/)
  assert.match(page, /fetch\(['"]\/api\/facebook-audit['"]/)
  assert.match(page, /values\.authorized\s*=\s*document\.querySelector\(['"]#authorized['"]\)\.checked/)
  assert.match(page, /result\.classList\.remove\(['"]hidden['"]\)/)
  assert.match(page, /form\.classList\.add\(['"]hidden['"]\)/)
})
