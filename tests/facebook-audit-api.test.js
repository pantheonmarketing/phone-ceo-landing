const test = require('node:test')
const assert = require('node:assert/strict')

const { createHandler } = require('../api/facebook-audit')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    setHeader() { return this },
    json(body) { this.body = body; return this }
  }
}

test('facebook audit endpoint rejects a request without authorization', async () => {
  const handler = createHandler({ store: new MemoryAuditStore(), notifyTelegram: async () => {} })
  const res = makeResponse()
  await handler({ method: 'POST', body: { pageUrl: 'https://facebook.com/example' } }, res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /authorization/)
})

test('facebook audit endpoint queues an authorized request and notifies Telegram', async () => {
  const store = new MemoryAuditStore()
  const notifications = []
  const handler = createHandler({
    store,
    notifyTelegram: async audit => notifications.push(audit)
  })
  const res = makeResponse()
  await handler({ method: 'POST', body: {
    businessName: 'Example Business',
    pageUrl: 'https://facebook.com/examplebusiness',
    customerQuestion: 'Do you have availability?',
    authorized: true
  } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.match(res.body.auditId, /^FBA-/)
  assert.match(res.body.reportToken, /^[a-f0-9]{48}$/)
  assert.match(res.body.reportUrl, new RegExp(res.body.auditId))
  assert.match(res.body.reportUrl, /#auditId=/)
  assert.equal(notifications.length, 1)

  const stored = await store.get(res.body.auditId)
  assert.equal(stored.status, 'queued')
  assert.equal(stored.authorized, true)
  assert.equal(stored.events[0].type, 'submitted')
  assert.equal(stored.reportTokenHash.length, 64)
})

test('facebook audit GET returns a token-protected sanitized report', async () => {
  const store = new MemoryAuditStore()
  const handler = createHandler({ store, notifyTelegram: async () => {} })
  const post = makeResponse()
  await handler({ method: 'POST', body: {
    businessName: 'Example Business',
    pageUrl: 'https://facebook.com/examplebusiness',
    customerQuestion: 'Do you have availability?',
    authorized: true
  } }, post)

  const denied = makeResponse()
  await handler({ method: 'GET', query: { auditId: post.body.auditId, token: 'wrong' } }, denied)
  assert.equal(denied.statusCode, 404)

  const allowed = makeResponse()
  await handler({
    method: 'GET',
    query: { auditId: post.body.auditId },
    headers: { 'x-audit-report-token': post.body.reportToken }
  }, allowed)
  assert.equal(allowed.statusCode, 200)
  assert.equal(allowed.body.auditId, post.body.auditId)
  assert.equal(allowed.body.status, 'queued')
  assert.equal('reportTokenHash' in allowed.body, false)
  assert.equal('testMessage' in allowed.body, false)
})
