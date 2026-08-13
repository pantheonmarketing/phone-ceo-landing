const path = require('node:path')
const { createAuditStoreFromEnv } = require('../lib/facebook-audit-store')
const { notifyFinalTelegram, notifyLateReplyTelegram } = require('../api/facebook-audit')
const { notifyFinalTelegram: notifyWebsiteFinalTelegram } = require('../api/website-audit')
const { AuditWorker } = require('./audit-worker')
const { createDashboardServer } = require('./dashboard-server')
const { FacebookMessengerBrowser } = require('./facebook-messenger-browser')
const { WebsiteAuditBrowser } = require('./website-audit-browser')
const { WebsiteAuditWorker } = require('./website-audit-worker')
const { MultiAuditWorker } = require('./multi-audit-worker')
const { FacebookAuditJournal } = require('./journal')
const { recoverInterruptedSends } = require('./recovery')
const { AuditWorkerController } = require('./worker-controller')
const { resolveAuditBrowserProfile } = require('./config')

function loadLocalEnvironment() {
  for (const name of ['.env.local', '.env']) {
    try { process.loadEnvFile(path.join(process.cwd(), name)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function main() {
  loadLocalEnvironment()
  const profileDirectory = resolveAuditBrowserProfile(process.env, process.cwd())

  const store = createAuditStoreFromEnv()
  const journal = new FacebookAuditJournal(path.join(process.cwd(), 'data', 'facebook-audit-worker-journal.ndjson'))
  await recoverInterruptedSends(store, journal)

  const browser = new FacebookMessengerBrowser({
    profileDirectory,
    channel: process.env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.FACEBOOK_AUDIT_EXECUTABLE_PATH || '',
    headless: process.env.FACEBOOK_AUDIT_HEADLESS === 'true'
  })
  const facebookWorker = new AuditWorker({
    store,
    browser,
    journal,
    notifyFinal: notifyFinalTelegram,
    notifyLate: notifyLateReplyTelegram,
    lateReplyWindowMs: Number(process.env.FACEBOOK_AUDIT_LATE_REPLY_MS || 10 * 60 * 1000)
  })
  const websiteBrowser = new WebsiteAuditBrowser({
    channel: process.env.WEBSITE_AUDIT_BROWSER_CHANNEL || process.env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.WEBSITE_AUDIT_EXECUTABLE_PATH || process.env.FACEBOOK_AUDIT_EXECUTABLE_PATH || '',
    headless: process.env.WEBSITE_AUDIT_HEADLESS !== 'false'
  })
  const websiteWorker = new WebsiteAuditWorker({
    store,
    browser: websiteBrowser,
    journal,
    notifyFinal: notifyWebsiteFinalTelegram
  })
  const worker = new MultiAuditWorker([facebookWorker, websiteWorker])
  const controller = new AuditWorkerController({
    worker,
    pollIntervalMs: Number(process.env.FACEBOOK_AUDIT_POLL_MS || 3000)
  })
  const dashboard = createDashboardServer({
    store,
    controller,
    port: Number(process.env.FACEBOOK_AUDIT_DASHBOARD_PORT || 4317)
  })
  const dashboardState = await dashboard.start()
  controller.start()
  console.log(`AI CEOS audit worker is running. Dashboard: ${dashboardState.url}`)
  console.log('Browsers run only for queued, authorized Website or Facebook audits. Press Ctrl+C to stop safely.')

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('Stopping AI CEOS audit worker...')
    await controller.stop()
    await dashboard.stop()
    await browser.shutdown()
    await websiteBrowser.shutdown()
  }
  process.once('SIGINT', () => shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)))
}

if (require.main === module) {
  main().catch(error => {
    const safeMessage = error.publicMessage || 'Check the worker configuration and durable store connection.'
    console.error(`AI CEOS audit worker could not start: ${safeMessage}`)
    process.exitCode = 1
  })
}

module.exports = { loadLocalEnvironment, main }
