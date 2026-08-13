const path = require('node:path')
const { FacebookMessengerBrowser } = require('./facebook-messenger-browser')
const { resolveAuditBrowserProfile } = require('./config')

for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(path.join(process.cwd(), name)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function createLoginBrowser(env = process.env, projectDirectory = process.cwd()) {
  return new FacebookMessengerBrowser({
    profileDirectory: resolveAuditBrowserProfile(env, projectDirectory),
    channel: env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
    executablePath: env.FACEBOOK_AUDIT_EXECUTABLE_PATH || '',
    headless: false
  })
}

async function main() {
  const browser = createLoginBrowser()
  await browser.openForLogin()
  console.log('Dedicated Facebook audit browser opened. Sign in, verify the account is ready, then close the browser window.')
  await new Promise(resolve => browser.context.once('close', resolve))
}

if (require.main === module) {
  main().catch(error => {
    const safeMessage = error.publicMessage || 'Check the dedicated browser configuration.'
    console.error(`Dedicated Facebook login could not open: ${safeMessage}`)
    process.exitCode = 1
  })
}

module.exports = { createLoginBrowser, main }
