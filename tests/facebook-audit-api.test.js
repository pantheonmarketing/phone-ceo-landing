const test = require('node:test')
const assert = require('node:assert/strict')

const { createHandler, createRateLimiter } = require('../api/facebook-audit')
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

test('rate limiter stays bounded and does not trust forwarded client headers', () => {
  const limiter = createRateLimiter({ limit: 1, maxKeys: 2 })
  limiter.check('one')
  limiter.check('two')
  limiter.check('three')
  assert.equal(limiter.size(), 2)
})

test('facebook audit handler uses the durable store limiter when available', async () => {
  const store = new MemoryAuditStore()
  let checks = 0
  store.consumeRateLimit = async () => {
    checks += 1
    return checks === 1 ? { allowed: true, remaining: 4 } : { allowed: false, retryAfterSeconds: 600 }
  }
  const handler = createHandler({ store, notifyTelegram: async () => {} })
  const first = makeResponse()
  await handler({ method: 'POST', socket: { remoteAddress: '10.0.0.1' }, body: { authorized: true, pageUrl: 'https://facebook.com/shared-limit' } }, first)
  assert.equal(first.statusCode, 200)
  const second = makeResponse()
  await handler({ method: 'POST', socket: { remoteAddress: '10.0.0.2' }, body: { authorized: true, pageUrl: 'https://facebook.com/shared-limit' } }, second)
  assert.equal(second.statusCode, 429)
  assert.equal(checks, 2)
})

test('facebook audit endpoint rejects cross-origin requests and rate-limits POSTs', async () => {
  const store = new MemoryAuditStore()
  const handler = createHandler({
    store,
    notifyTelegram: async () => {},
    rateLimiter: createRateLimiter({ limit: 1, windowMs: 60000 })
  })

  const crossOrigin = makeResponse()
  await handler({ method: 'POST', headers: { host: 'audit.example', origin: 'https://attacker.example' }, body: {} }, crossOrigin)
  assert.equal(crossOrigin.statusCode, 403)

  const body = { pageUrl: 'https://facebook.com/limited', authorized: true }
  const request = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'audit.example', origin: 'https://audit.example', 'x-forwarded-for': '10.0.0.1' }, body }
  const first = makeResponse()
  await handler(request, first)
  assert.equal(first.statusCode, 200)

  const second = makeResponse()
  await handler({ ...request, headers: { ...request.headers, 'x-forwarded-for': '10.0.0.2' } }, second)
  assert.equal(second.statusCode, 429)
  assert.match(second.body.error, /too many/i)
})

test('facebook audit endpoint rejects oversized request bodies before queueing', async () => {
  const store = new MemoryAuditStore()
  const handler = createHandler({ store, notifyTelegram: async () => {} })
  const res = makeResponse()
  await handler({ method: 'POST', body: { authorized: true, pageUrl: 'https://facebook.com/example', padding: 'x'.repeat(17000) } }, res)
  assert.equal(res.statusCode, 413)
  assert.equal((await store.list()).length, 0)
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
