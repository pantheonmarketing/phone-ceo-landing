const crypto = require('node:crypto')
const { classifyFacebookReply, scoreFacebookAudit } = require('../lib/facebook-audit')
const {
  addEvidence,
  applyLateReplyObservation,
  applyReplyObservation,
  confirmMessageSent,
  prepareMessageSend,
  recordAuditEvent,
  transitionAudit
} = require('../lib/facebook-audit-state')

class AuditWorker {
  constructor({
    store,
    browser,
    workerId,
    journal,
    notifyFinal,
    notifyLate,
    lateReplyWindowMs = 0,
    now = () => new Date()
  }) {
    if (!store || !browser) throw new Error('AuditWorker requires a store and browser adapter')
    this.store = store
    this.browser = browser
    this.workerId = workerId || `worker-${crypto.randomBytes(4).toString('hex')}`
    this.journal = journal || { append() {} }
    this.notifyFinal = notifyFinal || (async () => {})
    this.notifyLate = notifyLate || (async () => {})
    this.lateReplyWindowMs = Math.max(0, Number(lateReplyWindowMs) || 0)
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

  async _notifyLateWithoutChangingResult(audit, reply) {
    try {
      await this.notifyLate(audit, reply)
    } catch {
      try {
        await this.store.update(audit.auditId, current => recordAuditEvent(current, 'notification_failed', {
          status: current.status,
          message: 'Late-reply private notification failed'
        }, this.now()))
      } catch {}
    }
  }

  async _discloseAfterRealReply(auditId, classification, receivedAt) {
    if (classification?.isAutoAcknowledgement || !this.browser.sendAuditDisclosure) return null
    const audit = await this.store.get(auditId)
    if (!audit || audit.disclosure?.state !== 'pending') return null
    try {
      const sent = await this.browser.sendAuditDisclosure(audit.disclosureMessage, { auditId })
      const sentAt = new Date(sent?.sentAt || receivedAt || this.now())
      await this.store.update(auditId, current => {
        const next = recordAuditEvent(current, 'audit_disclosed', {
          status: current.status,
          message: 'Audit identity disclosed after a real business response'
        }, sentAt)
        next.disclosure = { state: 'sent', sentAt: sentAt.toISOString() }
        return next
      })
      await this._evidence(auditId, 'Audit disclosed after response')
      return sentAt
    } catch (error) {
      const failedAt = new Date(receivedAt || this.now())
      await this.store.update(auditId, current => {
        const next = recordAuditEvent(current, 'audit_disclosure_failed', {
          status: current.status,
          code: String(error.code || error.name || 'audit_disclosure_failed').slice(0, 120),
          message: 'Audit disclosure could not be confirmed; it will not be retried automatically'
        }, failedAt)
        next.disclosure = { state: 'failed', sentAt: null }
        return next
      }).catch(() => {})
      return null
    }
  }

  async _monitorLateReplies(audit) {
    if (audit.status !== 'failed' || audit.score?.grade !== 'F' || this.lateReplyWindowMs <= 120000) return audit
    const lateDeadlineAt = new Date(new Date(audit.sentAt).getTime() + this.lateReplyWindowMs)
    const monitoringAt = new Date(new Date(audit.completedAt).getTime() + 1)
    await this.store.update(audit.auditId, current => recordAuditEvent(current, 'late_reply_monitoring', {
      status: current.status,
      lateReplyDeadlineAt: lateDeadlineAt.toISOString(),
      message: 'Result is final; monitoring briefly for useful late replies without changing the grade'
    }, monitoringAt))
    try {
      const observation = await this.browser.observeUntil({
        audit,
        deadlineAt: lateDeadlineAt,
        onReply: async reply => {
          const receivedAt = new Date(reply.receivedAt || this.now())
          if (receivedAt.getTime() <= new Date(audit.deadlineAt).getTime()) return { stop: false }
          const latest = await this.store.get(audit.auditId)
          const classification = classifyFacebookReply(reply.text, { customerQuestion: latest.customerQuestion })
          const updated = await this.store.update(audit.auditId, current => applyLateReplyObservation(current, {
            text: reply.text,
            receivedAt,
            classification
          }))
          await this._evidence(audit.auditId, classification.isUseful ? 'Useful late reply detected' : 'Late reply detected')
          await this._discloseAfterRealReply(audit.auditId, classification, receivedAt)
          await this._notifyLateWithoutChangingResult(await this.store.get(audit.auditId), updated.replies.at(-1))
          return { stop: classification.isUseful, classification }
        }
      })
      const closedAt = new Date(observation?.observedUntil || lateDeadlineAt)
      await this.store.update(audit.auditId, current => recordAuditEvent(current, 'late_reply_window_closed', {
        status: current.status,
        message: current.replies.some(reply => reply.isLate && reply.classification?.isUseful)
          ? 'Useful late reply recorded; original two-minute grade unchanged'
          : 'Late-reply monitoring window closed; original grade unchanged'
      }, closedAt))
    } catch (error) {
      await this.store.update(audit.auditId, current => recordAuditEvent(current, 'late_reply_monitor_error', {
        status: current.status,
        code: String(error.code || error.name || 'late_reply_monitor_error').slice(0, 120),
        message: 'Late-reply monitoring ended early; original two-minute grade unchanged'
      }, this.now())).catch(() => {})
    }
    return this.store.get(audit.auditId)
  }

  async processNext() {
    const claimed = await this.store.claimNext(this.workerId, this.now(), { auditTypes: ['facebook'] })
    if (!claimed) return null
    const auditId = claimed.auditId

    try {
      await this._event(auditId, 'page_opening', { status: 'starting', message: 'Opening submitted Facebook Page' })
      const pageState = await this.browser.openPage(claimed)
      if (!pageState?.loggedIn) {
        const pageError = pageState?.reason === 'facebook_page_host_unverified'
        const identityError = pageState?.reason === 'facebook_page_identity_unverified'
        const error = await this._error(
          auditId,
          pageError ? 'facebook_page_host_unverified' : identityError ? 'facebook_page_identity_unverified' : 'facebook_login_required',
          pageError
            ? 'The opened page was not verified as a Facebook Page'
            : identityError
              ? 'The opened Facebook Page did not match the submitted Page'
              : 'Dedicated Facebook audit profile must be logged in'
        )
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
          if (classification.isUseful) {
            await this._discloseAfterRealReply(auditId, classification, reply.receivedAt)
          }
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
      let withEvidence = await this.store.get(auditId)
      if (withEvidence.disclosure?.state === 'pending') {
        const firstRealReply = withEvidence.replies.find(reply => !reply.classification?.isAutoAcknowledgement)
        if (firstRealReply) {
          await this._discloseAfterRealReply(auditId, firstRealReply.classification, observedUntil)
          withEvidence = await this.store.get(auditId)
        }
      }
      await this._notifyWithoutChangingResult(withEvidence)
      return this._monitorLateReplies(withEvidence)
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
