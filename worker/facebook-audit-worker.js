const path = require('node:path')
const { createAuditStoreFromEnv } = require('../lib/facebook-audit-store')
const { notifyFinalTelegram } = require('../api/facebook-audit')
const { AuditWorker } = require('./audit-worker')
const { createDashboardServer } = require('./dashboard-server')
const { FacebookMessengerBrowser } = require('./facebook-messenger-browser')
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
  const worker = new AuditWorker({ store, browser, journal, notifyFinal: notifyFinalTelegram })
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
  console.log(`Hermes audit worker is running. Dashboard: ${dashboardState.url}`)
  console.log('The browser will open only for a queued, authorized audit. Press Ctrl+C to stop safely.')

  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('Stopping Hermes audit worker...')
    await controller.stop()
    await dashboard.stop()
    await browser.shutdown()
  }
  process.once('SIGINT', () => shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)))
}

if (require.main === module) {
  main().catch(error => {
    const safeMessage = error.publicMessage || 'Check the worker configuration and durable store connection.'
    console.error(`Facebook audit worker could not start: ${safeMessage}`)
    process.exitCode = 1
  })
}

module.exports = { loadLocalEnvironment, main }
