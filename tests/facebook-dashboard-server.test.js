const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord } = require('../lib/facebook-audit-state')
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

  const html = await (await fetch(started.url)).text()
  assert.match(html, /Every worker action/i)

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
})
