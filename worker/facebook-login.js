const path = require('node:path')
const { FacebookMessengerBrowser } = require('./facebook-messenger-browser')
const { resolveAuditBrowserProfile } = require('./config')

for (const name of ['.env.local', '.env']) {
  try { process.loadEnvFile(path.join(process.cwd(), name)) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function main() {
  const browser = new FacebookMessengerBrowser({
    profileDirectory: resolveAuditBrowserProfile(process.env, process.cwd()),
    channel: process.env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
    headless: false
  })
  await browser.openForLogin()
  console.log('Dedicated Facebook audit browser opened. Sign in, verify the account is ready, then close the browser window.')
  await new Promise(resolve => browser.context.once('close', resolve))
}

main().catch(error => {
  const safeMessage = error.publicMessage || 'Check the dedicated browser configuration.'
  console.error(`Dedicated Facebook login could not open: ${safeMessage}`)
  process.exitCode = 1
})
