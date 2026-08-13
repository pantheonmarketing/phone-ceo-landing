const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { buildWebsiteAuditRequest, createReportToken, hashReportToken } = require('../lib/website-audit')
const { createWebsiteAuditRecord } = require('../lib/website-audit-state')
const { FileAuditStore } = require('../lib/facebook-audit-store')
const { WebsiteAuditBrowser } = require('../worker/website-audit-browser')
const { WebsiteAuditWorker } = require('../worker/website-audit-worker')

async function startFixture() {
  const html = await fs.readFile(path.join(__dirname, '..', 'tests', 'fixtures', 'website-business.html'), 'utf8')
  let sends = 0
  let formSubmissions = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/fixture-send') {
      sends += 1
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'POST' && req.url === '/fixture-form-submit') {
      formSubmissions += 1
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
    url: `http://127.0.0.1:${address.port}/`,
    sends: () => sends,
    formSubmissions: () => formSubmissions,
    stop: () => new Promise(resolve => server.close(resolve))
  }
}

async function main() {
  const fixture = await startFixture()
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'website-audit-smoke-'))
  let browser
  try {
    const store = new FileAuditStore({ directory: path.join(temp, 'store') })
    const request = buildWebsiteAuditRequest({
      businessName: 'Controlled Website Smoke',
      websiteUrl: 'https://example.com',
      customerQuestion: 'Is the August 23 AI workshop still available and what does it cost?',
      authorized: true
    })
    request.websiteUrl = fixture.url
    await store.create(createWebsiteAuditRecord(request, hashReportToken(createReportToken())))

    browser = new WebsiteAuditBrowser({
      channel: process.env.FACEBOOK_AUDIT_BROWSER_CHANNEL || 'chrome',
      executablePath: process.env.FACEBOOK_AUDIT_EXECUTABLE_PATH || '',
      headless: true,
      pollIntervalMs: 100,
      allowPrivateNetwork: true
    })
    const notifications = []
    const worker = new WebsiteAuditWorker({
      store,
      browser,
      workerId: 'controlled-website-smoke-worker',
      notifyFinal: async audit => notifications.push(audit.auditId)
    })

    const result = await worker.processNext()
    const eventTypes = result.events.map(event => event.type)

    if (result.status === 'error') {
      throw new Error(`${result.error?.code || 'website_smoke_error'}: ${result.error?.message || 'unknown controlled smoke error'}`)
    }
    assert.equal(result.status, 'completed')
    assert.equal(result.score.total, 100)
    assert.equal(result.score.grade, 'A')
    assert.equal(result.sendGuard.state, 'sent')
    assert.equal(result.observations.contactFormFieldCount, 3)
    assert.equal(result.observations.chatAvailable, true)
    assert.equal(result.replies.length, 1)
    assert.equal(fixture.sends(), 2, 'fixture must record one buyer question and one post-reply disclosure')
    assert.equal(fixture.formSubmissions(), 0, 'contact forms must never be submitted')
    assert.deepEqual(notifications, [result.auditId])
    assert.ok(result.evidence.length >= 4)
    for (const required of ['submitted', 'starting', 'website_opening', 'mapping', 'contact_paths_mapped', 'testing', 'message_prepared', 'message_sent', 'reply_detected', 'audit_disclosed', 'completed']) {
      assert.ok(eventTypes.includes(required), `Missing smoke event: ${required}`)
    }

    console.log('Controlled website browser smoke: PASS')
    console.log(`Audit status: ${result.status}; score: ${result.score.total}/100 (${result.score.grade})`)
    console.log(`Browser sends recorded: ${fixture.sends()} (one buyer question, one post-reply disclosure)`)
    console.log(`Contact form submissions: ${fixture.formSubmissions()}`)
    console.log(`Timestamped events: ${result.events.length}; evidence frames: ${result.evidence.length}`)
  } finally {
    if (browser) await browser.shutdown()
    await fixture.stop()
    const resolvedTemp = path.resolve(temp)
    if (resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolvedTemp).startsWith('website-audit-smoke-')) {
      await fs.rm(resolvedTemp, { recursive: true, force: true })
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Controlled website browser smoke: FAIL - ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { startFixture }
