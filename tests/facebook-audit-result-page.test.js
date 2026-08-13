const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const page = fs.readFileSync(path.join(__dirname, '..', 'facebook-audit-result.html'), 'utf8')

test('approved light report centers the score, measured gap, and friendly journey', () => {
  assert.match(page, /Performance score/i)
  assert.match(page, /\/100/)
  assert.match(page, /away from an A/i)
  assert.match(page, /Audit journey/i)
  assert.match(page, /Submitted/i)
  assert.match(page, /Messenger reached/i)
  assert.match(page, /Question sent/i)
  assert.match(page, /Reply received/i)
  assert.match(page, /Result ready/i)
  assert.match(page, /View full audit evidence/i)
  assert.match(page, /What this could be costing you/i)
  assert.match(page, /This is an estimate based only on the numbers you enter/i)
})

test('revenue exposure stays blank until the owner enters assumptions', () => {
  assert.doesNotMatch(page, /value=["'](?:50|200|500|30|35)["']/i)
  assert.match(page, /Enter your numbers to calculate/i)
  assert.match(page, /Monthly Facebook inquiries/i)
  assert.match(page, /Average customer value/i)
  assert.match(page, /Assumed missed-opportunity rate/i)
})

test('report remains dependency-free and renders untrusted reply text safely', () => {
  assert.doesNotMatch(page, /cdn\.tailwindcss\.com|iconify/i)
  assert.match(page, /item\.textContent\s*=\s*reply\.isLate/i)
  assert.match(page, /operational failure, not an F/i)
  assert.match(page, /X-Audit-Report-Token/)
})
