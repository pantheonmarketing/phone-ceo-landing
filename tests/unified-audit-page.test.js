const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'facebook-audit.html'), 'utf8')

test('one public form offers Website, Facebook, or Both with friendly icons', () => {
  assert.match(page, /AI CEOS Lost Customer Audit/i)
  assert.match(page, /value=["']website["']/i)
  assert.match(page, /value=["']facebook["']/i)
  assert.match(page, /value=["']both["']/i)
  assert.match(page, /Website URL/i)
  assert.match(page, /Facebook Page URL/i)
  assert.match(page, /Run Both Audits/i)
  assert.match(page, /inspect contact forms but never submit/i)
  assert.match(page, /at most one website live-chat question/i)
  assert.match(page, /at most one Facebook message/i)
  assert.match(page, /\.choice-body\{display:block/i)
  assert.doesNotMatch(page, /cdn\.tailwindcss\.com|iconify/i)
})

test('unified form submits only selected channels and opens one combined report', () => {
  assert.match(page, /submitAudit\(["']\/api\/website-audit["']/i)
  assert.match(page, /submitAudit\(["']\/api\/facebook-audit["']/i)
  assert.match(page, /audit-result\.html#/i)
  assert.match(page, /Promise\.allSettled/i)
})
