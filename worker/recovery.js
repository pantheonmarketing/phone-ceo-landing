const { transitionAudit } = require('../lib/facebook-audit-state')

async function recoverInterruptedSends(store, journal) {
  const starting = await store.list({ statuses: ['starting'], limit: 250 })
  const entries = await journal.read()
  const recovered = []
  for (const audit of starting) {
    if (audit.sendGuard?.state !== 'prepared') continue
    const sent = entries.find(entry =>
      entry.type === 'browser_send_completed' &&
      entry.auditId === audit.auditId &&
      entry.attemptId === audit.sendGuard.attemptId
    )
    const code = sent ? 'send_recovery_required' : 'send_ambiguous'
    const message = sent
      ? 'The browser recorded a send, but durable confirmation was interrupted. Manual review is required; the worker will not send again.'
      : 'The worker stopped after preparing a send. Delivery is unknown; the worker will not retry automatically.'
    const updated = await store.update(audit.auditId, current => transitionAudit(current, 'error', { code, message }))
    recovered.push(updated)
  }
  return recovered
}

module.exports = { recoverInterruptedSends }
