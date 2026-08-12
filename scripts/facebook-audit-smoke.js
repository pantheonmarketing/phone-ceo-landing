const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord } = require('../lib/facebook-audit-state')
const { FileAuditStore } = require('../lib/facebook-audit-store')
const { AuditWorker } = require('../worker/audit-worker')
const { createDashboardServer } = require('../worker/dashboard-server')
const { FacebookMessengerBrowser } = require('../worker/facebook-messenger-browser')
const { FacebookAuditJournal } = require('../worker/journal')
const { AuditWorkerController } = require('../worker/worker-controller')

async function startFixture() {
  const html = await fs.readFile(path.join(__dirname, '..', 'tests', 'fixtures', 'facebook-page.html'), 'utf8')
  let sends = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/fixture-send') {
      sends += 1
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/facebook-page`,
    html: () => html,
    recordSend: () => { sends += 1 },
    sends: () => sends,
    stop: () => new Promise(resolve => server.close(resolve))
  }
}

async function waitForResult(store, auditId, timeoutMs = 20000) {
  const expires = Date.now() + timeoutMs
  while (Date.now() < expires) {
    const record = await store.get(auditId)
    if (record && ['passed', 'failed', 'error'].includes(record.status)) return record
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Controlled smoke audit did not reach a terminal state')
}

function linuxBrowserAvailable() {
  if (process.platform !== 'linux') return true
  const candidates = [process.env.FACEBOOK_AUDIT_EXECUTABLE_PATH, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean)
  return candidates.some(candidate => {
    try {
      execFileSync('which', [candidate], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
}

async function waitFor(condition, timeoutMs = 5000) {
  const expires = Date.now() + timeoutMs
  while (Date.now() < expires) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Controlled smoke post-result work did not finish')
}

function createFixtureRouteHandler(fixture) {
  return async route => {
    if (new URL(route.request().url()).pathname === '/fixture-send') {
      fixture.recordSend()
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture.html() })
  }
}

async function installFixtureRoutes(context, fixture) {
  const handler = createFixtureRouteHandler(fixture)
  await context.route('https://facebook.com/**', handler)
  await context.route('https://www.facebook.com/**', handler)
}

function configureFixtureBrowser(browser, fixture) {
  const launch = browser.launch.bind(browser)
  let routedContext = null
  browser.launch = async () => {
    const context = await launch()
    if (context !== routedContext) {
      await installFixtureRoutes(context, fixture)
      routedContext = context
    }
    return context
  }
  return browser
}

async function main() {
  const fixture = await startFixture()
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-smoke-'))
  let dashboard
  let controller
  let browser
  try {
    const store = new FileAuditStore({ directory: path.join(temp, 'store') })
    const request = buildAuditRequest({
      businessName: 'Controlled Browser Smoke',
      pageUrl: 'https://facebook.com/controlled-smoke',
      customerQuestion: 'Do you have availability this week and what does it cost?',
      authorized: true
    })
    const record = createAuditRecord(request, hashReportToken(createReportToken()))
    await store.create(record)

    browser = configureFixtureBrowser(new FacebookMessengerBrowser({
      profileDirectory: path.join(temp, 'browser-profile'),
      channel: process.env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
      headless: true,
      pollIntervalMs: 100
    }), fixture)
    const notifications = []
    const worker = new AuditWorker({
      store,
      browser,
      workerId: 'controlled-smoke-worker',
      journal: new FacebookAuditJournal(path.join(temp, 'journal.ndjson')),
      notifyFinal: async audit => notifications.push(audit.auditId)
    })
    controller = new AuditWorkerController({ worker, pollIntervalMs: 250 })
    dashboard = createDashboardServer({
      store,
      controller,
      port: Number(process.env.FACEBOOK_AUDIT_SMOKE_DASHBOARD_PORT || 0)
    })
    const dashboardState = await dashboard.start()
    controller.start()

    await waitForResult(store, record.auditId)
    await waitFor(() => notifications.length === 1)
    const result = await store.get(record.auditId)
    if (result.status === 'error' && result.error?.code === 'browser_launch_failed' && !linuxBrowserAvailable()) {
      console.log('Controlled browser smoke: SKIP - Linux/WSL has no configured Chrome executable; run this smoke in the supported Windows environment.')
      return
    }
    const dashboardResponse = await fetch(dashboardState.url)
    const dashboardData = await (await fetch(`${dashboardState.url}api/audits`)).json()
    const eventTypes = result.events.map(event => event.type)

    assert.equal(result.status, 'passed')
    assert.equal(result.score.grade, 'A')
    assert.equal(result.sendGuard.state, 'sent')
    assert.equal(fixture.sends(), 1, 'controlled fixture must record exactly one browser send')
    assert.equal(notifications.length, 1, 'worker must emit exactly one final notification')
    assert.ok(result.evidence.length >= 2)
    for (const required of ['submitted', 'starting', 'page_opening', 'page_opened', 'messenger_reachable', 'message_prepared', 'message_sent', 'waiting', 'reply_detected', 'passed']) {
      assert.ok(eventTypes.includes(required), `Missing smoke event: ${required}`)
    }
    assert.equal(dashboardResponse.status, 200)
    assert.equal(dashboardResponse.headers.get('x-frame-options'), 'DENY')
    assert.match(dashboardResponse.headers.get('content-type'), /text\/html/i)
    assert.equal(dashboardData.audits[0].auditId, record.auditId)
    assert.equal('reportTokenHash' in dashboardData.audits[0], false)

    console.log('Controlled browser smoke: PASS')
    console.log(`Audit status: ${result.status}; grade: ${result.score.grade}`)
    console.log(`Browser sends recorded: ${fixture.sends()}`)
    console.log(`Timestamped events: ${result.events.length}; evidence frames: ${result.evidence.length}`)
    console.log('Live dashboard API and rendered shell: verified')
    const holdMs = Number(process.env.FACEBOOK_AUDIT_SMOKE_HOLD_MS || 0)
    if (holdMs > 0) {
      console.log(`Smoke dashboard held for visual verification: ${dashboardState.url}`)
      await new Promise(resolve => setTimeout(resolve, holdMs))
    }
  } finally {
    if (controller) await controller.stop()
    if (dashboard) await dashboard.stop()
    if (browser) await browser.shutdown()
    await fixture.stop()
    await fs.rm(temp, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Controlled browser smoke: FAIL - ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { configureFixtureBrowser, createFixtureRouteHandler, installFixtureRoutes }
