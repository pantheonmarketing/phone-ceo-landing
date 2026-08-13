const test = require('node:test')
const assert = require('node:assert/strict')

const { createHandler } = require('../api/website-audit')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    json(body) { this.body = body; return this }
  }
}

test('website audit endpoint queues an authorized public website', async () => {
  const store = new MemoryAuditStore()
  const notices = []
  const handler = createHandler({ store, notifyTelegram: async audit => notices.push(audit.auditId) })
  const res = response()

  await handler({ method: 'POST', body: {
    businessName: 'Website Business',
    websiteUrl: 'https://example.com',
    customerQuestion: 'Do you have availability?',
    authorized: true
  } }, res)

  assert.equal(res.statusCode, 200)
  assert.match(res.body.auditId, /^WBA-[A-F0-9]{8}$/)
  assert.match(res.body.reportToken, /^[a-f0-9]{48}$/)
  assert.equal(notices.length, 1)
  const stored = await store.get(res.body.auditId)
  assert.equal(stored.auditType, 'website')
  assert.equal(stored.status, 'queued')

  const report = response()
  await handler({ method: 'GET', query: { auditId: res.body.auditId, token: res.body.reportToken } }, report)
  assert.equal(report.statusCode, 200)
  assert.equal(report.body.auditId, res.body.auditId)
  assert.equal('reportTokenHash' in report.body, false)
})

test('website endpoint rejects private targets, abusive language, and missing authorization', async () => {
  const store = new MemoryAuditStore()
  const handler = createHandler({ store, notifyTelegram: async () => {} })
  for (const body of [
    { websiteUrl: 'http://127.0.0.1', authorized: true },
    { websiteUrl: 'https://example.com', customerQuestion: 'What the f*ck?', authorized: true },
    { websiteUrl: 'https://example.com', authorized: false }
  ]) {
    const res = response()
    await handler({ method: 'POST', body }, res)
    assert.equal(res.statusCode, 400)
  }
  assert.equal((await store.list()).length, 0)
})

test('website endpoint stores a safe Telegram failure code without storing private details', async () => {
  const store = new MemoryAuditStore()
  const handler = createHandler({
    store,
    notifyTelegram: async () => {
      const error = new Error('private Telegram response text')
      error.code = 'telegram_http_400_api_400'
      throw error
    }
  })
  const res = response()

  await handler({ method: 'POST', body: {
    businessName: 'Website Business',
    websiteUrl: 'https://example.com',
    customerQuestion: 'Do you have availability?',
    authorized: true
  } }, res)

  assert.equal(res.statusCode, 200)
  assert.match(res.body.notificationWarning, /could not be delivered/i)
  const stored = await store.get(res.body.auditId)
  const failure = stored.events.find(event => event.type === 'notification_failed')
  assert.equal(failure.code, 'telegram_http_400_api_400')
  assert.doesNotMatch(JSON.stringify(stored), /private Telegram response text/)
})
