const path = require('node:path')

function resolveAuditBrowserProfile(env = process.env, projectDirectory = process.cwd()) {
  return env.FACEBOOK_AUDIT_PROFILE_DIR || path.join(
    path.resolve(projectDirectory),
    'data',
    'facebook-audit-browser-profile'
  )
}

module.exports = { resolveAuditBrowserProfile }
