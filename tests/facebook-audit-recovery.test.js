const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord, prepareMessageSend } = require('../lib/facebook-audit-state')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')
const { recoverInterruptedSends } = require('../worker/recovery')

test('startup recovery never retries a prepared or journaled browser send', async () => {
  const store = new MemoryAuditStore()
  const request = buildAuditRequest({
    businessName: 'Recovery Business',
    pageUrl: 'https://facebook.com/recoverybusiness',
    customerQuestion: 'Are you available?',
    authorized: true
  })
  await store.create(createAuditRecord(request, hashReportToken(createReportToken())))
  const claimed = await store.claimNext('worker-a')
  await store.update(claimed.auditId, current => prepareMessageSend(current, 'attempt-recovery'))

  const recovered = await recoverInterruptedSends(store, {
    read: async () => [{
      type: 'browser_send_completed',
      auditId: claimed.auditId,
      attemptId: 'attempt-recovery',
      sentAt: new Date().toISOString()
    }]
  })

  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].status, 'error')
  assert.equal(recovered[0].error.code, 'send_recovery_required')
  assert.equal(recovered[0].sendGuard.state, 'prepared')
  assert.equal(recovered[0].score, null)
})
