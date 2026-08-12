const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { resolveAuditBrowserProfile } = require('../worker/config')

test('audit browser uses an explicit dedicated profile when configured', () => {
  const configured = path.join('D:', 'private', 'hermes-facebook')
  assert.equal(resolveAuditBrowserProfile({ FACEBOOK_AUDIT_PROFILE_DIR: configured }, 'C:\\project'), configured)
})

test('audit browser defaults to a git-ignored profile inside the project data directory', () => {
  const project = path.resolve('C:\\project')
  assert.equal(
    resolveAuditBrowserProfile({}, project),
    path.join(project, 'data', 'facebook-audit-browser-profile')
  )
})
