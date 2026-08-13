const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const projectRoot = path.join(__dirname, '..')

test('autostart installer creates the worker task and a desktop dashboard shortcut', () => {
  const script = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'install-facebook-audit-autostart.ps1'),
    'utf8'
  )

  assert.match(script, /Register-ScheduledTask/)
  assert.match(script, /Phone CEO Facebook Audit Worker/)
  assert.match(script, /Facebook Audit Dashboard\.url/)
  assert.match(script, /URL=http:\/\/127\.0\.0\.1:4317\//)
})
