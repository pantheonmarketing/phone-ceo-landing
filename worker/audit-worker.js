const crypto = require('node:crypto')
const { classifyFacebookReply, scoreFacebookAudit } = require('../lib/facebook-audit')
const {
  addEvidence,
  applyReplyObservation,
  confirmMessageSent,
  prepareMessageSend,
  recordAuditEvent,
  transitionAudit
} = require('../lib/facebook-audit-state')

class AuditWorker {
  constructor({ store, browser, workerId, journal, notifyFinal, now = () => new Date() }) {
    if (!store || !browser) throw new Error('AuditWorker requires a store and browser adapter')
    this.store = store
    this.browser = browser
    this.workerId = workerId || `worker-${crypto.randomBytes(4).toString('hex')}`
    this.journal = journal || { append() {} }
    this.notifyFinal = notifyFinal || (async () => {})
    this.now = now
  }

  async _event(auditId, type, details = {}, at = this.now()) {
    return this.store.update(auditId, current => recordAuditEvent(current, type, details, at))
  }

  async _evidence(auditId, label) {
    if (!this.browser.captureEvidence) return null
    const evidence = await this.browser.captureEvidence({ auditId, label })
    if (!evidence) return null
    let reference = evidence.reference
    if (evidence.buffer && this.store.putEvidence) {
      reference = await this.store.putEvidence(auditId, {
        buffer: evidence.buffer,
        contentType: evidence.contentType,
        label
      })
    }
    return this.store.update(auditId, current => addEvidence(current, {
      ...evidence,
      buffer: undefined,
      reference
    }, evidence.capturedAt || this.now()))
  }

  async _error(auditId, code, message, at = this.now()) {
    const current = await this.store.get(auditId)
    if (!current || ['passed', 'failed', 'error'].includes(current.status)) return current
    return this.store.update(auditId, record => transitionAudit(record, 'error', { code, message }, at))
  }

  async _notifyWithoutChangingResult(audit) {
    try {
      await this.notifyFinal(audit)
    } catch (error) {
      try {
        await this.store.update(audit.auditId, current => recordAuditEvent(current, 'notification_failed', {
          status: current.status,
          message: 'Final private notification failed'
        }, this.now()))
      } catch {}
    }
  }

  async processNext() {
    const claimed = await this.store.claimNext(this.workerId, this.now())
    if (!claimed) return null
    const auditId = claimed.auditId

    try {
      await this._event(auditId, 'page_opening', { status: 'starting', message: 'Opening submitted Facebook Page' })
      const pageState = await this.browser.openPage(claimed)
      if (!pageState?.loggedIn) {
        const error = await this._error(auditId, 'facebook_login_required', 'Dedicated Facebook audit profile must be logged in')
        await this._notifyWithoutChangingResult(error)
        return error
      }
      if (pageState.dedicatedProfileSelected !== true) {
        const error = await this._error(auditId, 'facebook_profile_not_selected', 'The dedicated Facebook audit browser profile was not selected')
        await this._notifyWithoutChangingResult(error)
        return error
      }
      await this._event(auditId, 'page_opened', {
        status: 'starting',
        dedicatedProfileSelected: true,
        message: 'Dedicated audit browser profile selected; Facebook account identity remains a manual acceptance check'
      })

      const messenger = await this.browser.openMessenger(claimed)
      if (!messenger?.reachable) {
        const error = await this._error(auditId, 'messenger_unavailable', 'No usable Messenger contact entry point was found')
        await this._notifyWithoutChangingResult(error)
        return error
      }
      await this.store.update(auditId, current => {
        const next = recordAuditEvent(current, 'messenger_reachable', { status: 'starting', message: 'Messenger conversation is reachable' }, this.now())
        next.observations.channelReachable = true
        return next
      })
      await this._evidence(auditId, 'Messenger ready before send')

      const attemptId = crypto.randomUUID()
      const prepared = await this.store.update(auditId, current => prepareMessageSend(current, attemptId, this.now()))
      let sent
      try {
        sent = await this.browser.sendMessage(prepared.testMessage, { auditId, attemptId })
      } catch (error) {
        const ambiguous = await this._error(auditId, 'send_ambiguous', 'The browser send action did not complete cleanly. The worker will not retry automatically.')
        await this._notifyWithoutChangingResult(ambiguous)
        return ambiguous
      }
      const sentAt = new Date(sent?.sentAt || this.now())
      await Promise.resolve(this.journal.append({
        type: 'browser_send_completed',
        auditId,
        attemptId,
        sentAt: sentAt.toISOString()
      }))
      let current = await this.store.update(auditId, record => confirmMessageSent(record, attemptId, sentAt))
      current = await this.store.update(auditId, record => transitionAudit(record, 'waiting', {
        message: 'Watching Messenger for a useful reply'
      }, new Date(sentAt.getTime() + 1)))
      await this._evidence(auditId, 'Message sent')

      const observation = await this.browser.observeUntil({
        audit: current,
        deadlineAt: current.deadlineAt,
        onReply: async reply => {
          const latest = await this.store.get(auditId)
          const classification = classifyFacebookReply(reply.text, { customerQuestion: latest.customerQuestion })
          await this.store.update(auditId, record => applyReplyObservation(record, {
            text: reply.text,
            receivedAt: reply.receivedAt || this.now(),
            classification
          }))
          await this._evidence(auditId, classification.isUseful ? 'Useful reply detected' : 'Reply detected')
          return { stop: classification.isUseful, classification }
        }
      })

      current = await this.store.get(auditId)
      const observedUntil = new Date(observation?.observedUntil || this.now())
      const score = scoreFacebookAudit({
        sentAtMs: new Date(current.sentAt).getTime(),
        usefulReplyAtMs: current.usefulReplyAt ? new Date(current.usefulReplyAt).getTime() : null,
        observedUntilMs: observedUntil.getTime(),
        channelReachable: current.observations.channelReachable,
        autoAcknowledged: current.observations.autoAcknowledged
      })

      if (!score.grade) {
        const error = await this._error(auditId, 'observation_ended_early', 'Messenger observation ended before a result could be assigned', observedUntil)
        await this._notifyWithoutChangingResult(error)
        return error
      }

      const finalStatus = score.passed ? 'passed' : 'failed'
      const final = await this.store.update(auditId, record => transitionAudit(record, finalStatus, {
        score,
        message: score.label
      }, observedUntil))
      await this._evidence(auditId, `Audit ${finalStatus}`)
      const withEvidence = await this.store.get(auditId)
      await this._notifyWithoutChangingResult(withEvidence)
      return withEvidence
    } catch (error) {
      const failed = await this._error(
        auditId,
        error.code || 'worker_error',
        error.publicMessage || 'The audit worker encountered an operational error'
      )
      if (failed) await this._notifyWithoutChangingResult(failed)
      return failed
    } finally {
      try { await this.browser.closeAudit?.() } catch {}
    }
  }
}

module.exports = { AuditWorker }
