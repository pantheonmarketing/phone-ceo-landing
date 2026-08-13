const { transitionAudit } = require('../lib/facebook-audit-state')
const { transitionWebsiteAudit } = require('../lib/website-audit-state')

async function recoverInterruptedSends(store, journal) {
  const inFlight = await store.list({ statuses: ['starting', 'mapping', 'testing', 'message_sent', 'waiting'], limit: Number.MAX_SAFE_INTEGER })
  const entries = await journal.read()
  const recovered = []
  for (const audit of inFlight) {
    if (audit.auditType === 'website' || /^WBA-/i.test(audit.auditId)) {
      const message = audit.sendGuard?.state === 'sent'
        ? 'The worker stopped after a website chat question was sent. The result is unscored and the worker will not send again.'
        : audit.sendGuard?.state === 'prepared'
          ? 'The worker stopped during website chat send preparation. Delivery is unknown; the worker will not retry automatically.'
          : 'The worker stopped during a website inspection. The result is unscored.'
      const updated = await store.update(audit.auditId, current => transitionWebsiteAudit(current, 'error', {
        code: audit.sendGuard?.state === 'prepared' ? 'website_send_ambiguous' : 'website_audit_recovery_required',
        message
      }))
      recovered.push(updated)
      continue
    }
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
