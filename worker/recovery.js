const { transitionAudit } = require('../lib/facebook-audit-state')

async function recoverInterruptedSends(store, journal) {
  const inFlight = await store.list({ statuses: ['starting', 'message_sent', 'waiting'], limit: Number.MAX_SAFE_INTEGER })
  const entries = await journal.read()
  const recovered = []
  for (const audit of inFlight) {
    let code = 'audit_recovery_required'
    let message = 'The worker stopped during an in-flight audit. The result is unscored and the worker will not retry the send.'
    if (audit.status === 'starting') {
      const sent = audit.sendGuard?.state === 'prepared' && entries.some(entry =>
        entry.type === 'browser_send_completed' &&
        entry.auditId === audit.auditId &&
        entry.attemptId === audit.sendGuard.attemptId
      )
      code = sent ? 'send_recovery_required' : 'send_ambiguous'
      message = sent
        ? 'The browser recorded a send, but durable confirmation was interrupted. Manual review is required; the worker will not send again.'
        : 'The worker stopped during send preparation. Delivery is unknown; the worker will not retry automatically.'
    }
    const updated = await store.update(audit.auditId, current => transitionAudit(current, 'error', { code, message }))
    recovered.push(updated)
  }
  return recovered
}

module.exports = { recoverInterruptedSends }
