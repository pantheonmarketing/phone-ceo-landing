const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { applyReplyObservation, confirmMessageSent, createAuditRecord, prepareMessageSend, transitionAudit } = require('../lib/facebook-audit-state')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')
const { createDashboardServer } = require('../worker/dashboard-server')

test('local dashboard exposes sanitized audit data and worker controls', async t => {
  const store = new MemoryAuditStore()
  const request = buildAuditRequest({
    businessName: 'Dashboard Business',
    pageUrl: 'https://facebook.com/dashboardbusiness',
    customerQuestion: 'Are you available?',
    authorized: true
  })
  await store.create(createAuditRecord(request, hashReportToken(createReportToken())))

  let paused = false
  const controller = {
    getStatus: () => ({ state: paused ? 'paused' : 'idle', paused, lastPollAt: null, activeAuditId: null }),
    pause: () => { paused = true },
    resume: () => { paused = false }
  }
  const dashboard = createDashboardServer({ store, controller, port: 0 })
  const started = await dashboard.start()
  t.after(() => dashboard.stop())

  const dashboardResponse = await fetch(started.url)
  assert.equal(dashboardResponse.status, 200)
  assert.equal(dashboardResponse.headers.get('x-frame-options'), 'DENY')
  assert.match(dashboardResponse.headers.get('content-type'), /text\/html/i)

  const audits = await (await fetch(`${started.url}api/audits`)).json()
  assert.equal(audits.audits.length, 1)
  assert.equal(audits.audits[0].auditId, request.auditId)
  assert.equal('reportTokenHash' in audits.audits[0], false)

  const control = await fetch(`${started.url}api/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(control.status, 200)
  assert.equal((await control.json()).worker.paused, true)

  const external = await fetch(started.url, { headers: { origin: 'https://attacker.example' } })
  assert.equal(external.status, 403)
})

test('dashboard cannot bind publicly and manual review preserves conservative flags', async t => {
  const store = new MemoryAuditStore()
  const request = buildAuditRequest({
    businessName: 'Review Business',
    pageUrl: 'https://facebook.com/reviewbusiness',
    customerQuestion: 'Are you available?',
    authorized: true
  })
  let audit = createAuditRecord(request, hashReportToken(createReportToken()))
  audit = transitionAudit(audit, 'starting')
  audit = prepareMessageSend(audit, 'attempt-1')
  audit = confirmMessageSent(audit, 'attempt-1')
  audit = transitionAudit(audit, 'waiting')
  audit = applyReplyObservation(audit, {
    text: 'We received your message.',
    receivedAt: new Date(Date.now() + 1000),
    classification: { isAutoAcknowledgement: true, isUseful: false }
  })
  await store.create(audit)

  assert.throws(() => createDashboardServer({ store, controller: {}, host: '0.0.0.0' }), /loopback/i)
  const controller = { getStatus: () => ({ state: 'idle', paused: false }), on() {}, off() {} }
  const dashboard = createDashboardServer({ store, controller, port: 0 })
  const started = await dashboard.start()
  t.after(() => dashboard.stop())

  const replyId = audit.replies[0].replyId
  const response = await fetch(`${started.url}api/audits/${audit.auditId}/classify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replyId, isUseful: false })
  })
  assert.equal(response.status, 200)
  const updated = await store.get(audit.auditId)
  assert.equal(updated.replies[0].classification.isAutoAcknowledgement, true)
  assert.equal(updated.observations.clearNextAction, false)
})

test('local dashboard serves the existing audit form and queues only authorized submissions', async t => {
  const store = new MemoryAuditStore()
  const notifications = []
  const controller = {
    getStatus: () => ({ state: 'idle', paused: false, lastPollAt: null, activeAuditId: null }),
    on() {},
    off() {}
  }
  const dashboard = createDashboardServer({
    store,
    controller,
    port: 0,
    notifyInitial: async audit => notifications.push(audit.auditId)
  })
  const started = await dashboard.start()
  t.after(() => dashboard.stop())

  const formResponse = await fetch(`${started.url}facebook-audit.html`)
  assert.equal(formResponse.status, 200)
  assert.match(await formResponse.text(), /Lost Customer Audit/)

  const unauthorizedResponse = await fetch(`${started.url}api/facebook-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: 'Local Test Business',
      pageUrl: 'https://facebook.com/localtestbusiness',
      customerQuestion: 'When is the next event?',
      authorized: false
    })
  })
  assert.equal(unauthorizedResponse.status, 400)
  assert.equal((await store.list()).length, 0)

  const authorizedResponse = await fetch(`${started.url}api/facebook-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: 'Local Test Business',
      pageUrl: 'https://facebook.com/localtestbusiness',
      customerQuestion: 'When is the next event?',
      authorized: true
    })
  })
  assert.equal(authorizedResponse.status, 200)
  const queued = await authorizedResponse.json()
  assert.match(queued.auditId, /^FBA-[A-F0-9]{8}$/)
  assert.equal(notifications.length, 1)
  assert.deepEqual(notifications, [queued.auditId])
  assert.equal((await store.list()).length, 1)

  const resultPageResponse = await fetch(`${started.url}facebook-audit-result.html`)
  assert.equal(resultPageResponse.status, 200)
  assert.match(await resultPageResponse.text(), /AI CEOS Audit Results/i)

  const reportResponse = await fetch(`${started.url}api/facebook-audit?auditId=${queued.auditId}&token=${queued.reportToken}`)
  assert.equal(reportResponse.status, 200)
  assert.equal((await reportResponse.json()).auditId, queued.auditId)
})

test('local dashboard serves the shared report and queues an authorized website audit', async t => {
  const store = new MemoryAuditStore()
  const notifications = []
  const controller = {
    getStatus: () => ({ state: 'idle', paused: false, lastPollAt: null, activeAuditId: null }),
    on() {},
    off() {}
  }
  const dashboard = createDashboardServer({
    store,
    controller,
    port: 0,
    notifyWebsiteInitial: async audit => notifications.push(audit.auditId)
  })
  const started = await dashboard.start()
  t.after(() => dashboard.stop())

  const resultPageResponse = await fetch(`${started.url}audit-result.html`)
  assert.equal(resultPageResponse.status, 200)
  assert.match(await resultPageResponse.text(), /AI CEOS Audit Results/i)

  const response = await fetch(`${started.url}api/website-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: 'Website Test Business',
      websiteUrl: 'https://example.com',
      customerQuestion: 'What does your service cost?',
      authorized: true
    })
  })
  assert.equal(response.status, 200)
  const queued = await response.json()
  assert.match(queued.auditId, /^WBA-[A-F0-9]{8}$/)
  assert.deepEqual(notifications, [queued.auditId])

  const reportResponse = await fetch(`${started.url}api/website-audit?auditId=${queued.auditId}&token=${queued.reportToken}`)
  assert.equal(reportResponse.status, 200)
  assert.equal((await reportResponse.json()).auditId, queued.auditId)
})
