const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const page = fs.readFileSync(path.join(__dirname, '..', 'audit-result.html'), 'utf8')

test('shared result follows the approved friendly score-first standard', () => {
  assert.match(page, /AI CEOS Audit Results/i)
  assert.match(page, /Performance score/i)
  assert.match(page, /\/100/)
  assert.match(page, /Audit journey/i)
  assert.match(page, /Buyer Friction Map/i)
  assert.match(page, /Website/i)
  assert.match(page, /Facebook/i)
  assert.match(page, /operational failure, not a score/i)
  assert.match(page, /@keyframes journeyPulse/i)
  assert.match(page, /prefers-reduced-motion/i)
  assert.match(page, /© 2026 EngbrainAI\. A controlled, authorized mystery-customer test\./i)
  assert.doesNotMatch(page, /Hermes|cdn\.tailwindcss\.com|iconify/i)
})

test('combined score is shown only when every selected channel has a verified score', () => {
  assert.match(page, /every\(channel => Number\.isFinite\(channel\.score\)\)/i)
  assert.match(page, /Math\.round/i)
  assert.match(page, /X-Audit-Report-Token/i)
  assert.match(page, /\/api\/website-audit/i)
  assert.match(page, /\/api\/facebook-audit/i)
})
