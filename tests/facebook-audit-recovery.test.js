const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { confirmMessageSent, createAuditRecord, prepareMessageSend, transitionAudit } = require('../lib/facebook-audit-state')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')
const { recoverInterruptedSends } = require('../worker/recovery')

test('startup recovery marks every in-flight audit unscored without retrying', async () => {
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

  const confirmedRequest = buildAuditRequest({ businessName: 'Confirmed', pageUrl: 'https://facebook.com/confirmed', authorized: true })
  let confirmed = createAuditRecord(confirmedRequest, hashReportToken(createReportToken()))
  await store.create(confirmed)
  confirmed = await store.claimNext('worker-b')
  confirmed = await store.update(confirmed.auditId, current => prepareMessageSend(current, 'attempt-confirmed'))
  confirmed = await store.update(confirmed.auditId, current => confirmMessageSent(current, 'attempt-confirmed', new Date(Date.now() + 1000)))
  await store.update(confirmed.auditId, current => transitionAudit(current, 'waiting'))

  const messageSentRequest = buildAuditRequest({ businessName: 'Message Sent', pageUrl: 'https://facebook.com/message-sent', authorized: true })
  let messageSent = createAuditRecord(messageSentRequest, hashReportToken(createReportToken()))
  await store.create(messageSent)
  messageSent = await store.claimNext('worker-c')
  messageSent = await store.update(messageSent.auditId, current => prepareMessageSend(current, 'attempt-message-sent'))
  await store.update(messageSent.auditId, current => confirmMessageSent(current, 'attempt-message-sent', new Date(Date.now() + 1000)))

  const availableRequest = buildAuditRequest({ businessName: 'Available', pageUrl: 'https://facebook.com/available', authorized: true })
  let available = createAuditRecord(availableRequest, hashReportToken(createReportToken()))
  await store.create(available)
  available = await store.claimNext('worker-d')

  const recovered = await recoverInterruptedSends(store, {
    read: async () => [{
      type: 'browser_send_completed',
      auditId: claimed.auditId,
      attemptId: 'attempt-recovery',
      sentAt: new Date().toISOString()
    }]
  })

  assert.equal(recovered.length, 4)
  assert.deepEqual(new Set(recovered.map(audit => audit.auditId)), new Set([claimed.auditId, confirmed.auditId, messageSent.auditId, available.auditId]))
  assert.equal(recovered.find(audit => audit.auditId === claimed.auditId).error.code, 'send_recovery_required')
  assert.equal(recovered.find(audit => audit.auditId === confirmed.auditId).error.code, 'audit_recovery_required')
  assert.equal(recovered.find(audit => audit.auditId === messageSent.auditId).error.code, 'audit_recovery_required')
  assert.equal(recovered.find(audit => audit.auditId === confirmed.auditId).sendGuard.state, 'sent')
  assert.ok(recovered.every(audit => audit.score === null))
})
