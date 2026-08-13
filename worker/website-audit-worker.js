const crypto = require('node:crypto')
const { classifyFacebookReply } = require('../lib/facebook-audit')
const { calculateWebsiteAuditScore } = require('../lib/website-audit')
const { safeTelegramErrorCode } = require('../lib/telegram-notifier')
const {
  addWebsiteEvidence,
  applyWebsiteReply,
  completeWebsiteAudit,
  confirmWebsiteMessageSent,
  prepareWebsiteMessageSend,
  recordWebsiteEvent,
  recordWebsiteFindings,
  transitionWebsiteAudit
} = require('../lib/website-audit-state')

class WebsiteAuditWorker {
  constructor({ store, browser, workerId, journal, notifyFinal, now = () => new Date(), mappingTimeoutMs = 45000 }) {
    if (!store || !browser) throw new Error('WebsiteAuditWorker requires a store and browser adapter')
    this.store = store
    this.browser = browser
    this.workerId = workerId || `website-worker-${crypto.randomBytes(4).toString('hex')}`
    this.journal = journal || { append() {} }
    this.notifyFinal = notifyFinal || (async () => {})
    this.now = now
    this.mappingTimeoutMs = Math.max(1, Number(mappingTimeoutMs) || 45000)
  }

  async _withMappingDeadline(operation) {
    let timer
    try {
      return await Promise.race([
        operation,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error('Website contact-path mapping took too long'),
            {
              code: 'website_mapping_timeout',
              publicMessage: 'Website contact-path mapping took too long, so the audit stopped safely without sending a message.'
            }
          )), this.mappingTimeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async _event(auditId, type, details = {}, at = this.now()) {
    return this.store.update(auditId, current => recordWebsiteEvent(current, type, details, at))
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
    return this.store.update(auditId, current => addWebsiteEvidence(current, {
      ...evidence,
      buffer: undefined,
      reference
    }, evidence.capturedAt || this.now()))
  }

  async _error(auditId, code, message, at = this.now()) {
    const current = await this.store.get(auditId)
    if (!current || ['completed', 'error'].includes(current.status)) return current
    return this.store.update(auditId, record => transitionWebsiteAudit(record, 'error', { code, message }, at))
  }

  async _notify(audit) {
    try {
      await this.notifyFinal(audit)
    } catch (error) {
      await this.store.update(audit.auditId, current => recordWebsiteEvent(current, 'notification_failed', {
        status: current.status,
        code: safeTelegramErrorCode(error),
        message: 'Final private notification failed'
      }, this.now())).catch(() => {})
    }
  }

  async _disclose(auditId, classification, receivedAt) {
    if (classification?.isAutoAcknowledgement || !this.browser.sendAuditDisclosure) return
    const audit = await this.store.get(auditId)
    if (audit?.disclosure?.state !== 'pending') return
    try {
      const sent = await this.browser.sendAuditDisclosure(audit.disclosureMessage, { auditId })
      const at = new Date(sent?.sentAt || receivedAt || this.now())
      await this.store.update(auditId, current => {
        const next = recordWebsiteEvent(current, 'audit_disclosed', {
          status: current.status,
          message: 'Audit identity disclosed after a real website chat response'
        }, at)
        next.disclosure = { state: 'sent', sentAt: at.toISOString() }
        return next
      })
      await this._evidence(auditId, 'Audit disclosed after website reply')
    } catch (error) {
      await this.store.update(auditId, current => {
        const next = recordWebsiteEvent(current, 'audit_disclosure_failed', {
          status: current.status,
          code: String(error.code || error.name || 'website_disclosure_failed').slice(0, 120),
          message: 'Audit disclosure could not be confirmed; it will not be retried automatically'
        }, this.now())
        next.disclosure = { state: 'failed', sentAt: null }
        return next
      }).catch(() => {})
    }
  }

  async processNext() {
    const claimed = await this.store.claimNext(this.workerId, this.now(), { auditTypes: ['website'] })
    if (!claimed) return null
    const auditId = claimed.auditId
    try {
      await this._event(auditId, 'website_opening', { status: 'starting', message: 'Opening submitted public website' })
      const openState = await this.browser.openWebsite(claimed)
      if (!openState?.reachable) {
        const error = await this._error(auditId, 'website_unreachable', 'The submitted public website could not be reached')
        await this._notify(error)
        return error
      }
      await this.store.update(auditId, current => transitionWebsiteAudit(current, 'mapping', {
        message: 'Website opened; mapping public buyer contact paths'
      }, this.now()))
      await this._evidence(auditId, 'Website opened')

      const findings = await this._withMappingDeadline(this.browser.inspectBuyerJourney(openState))
      await this.store.update(auditId, current => recordWebsiteFindings(current, {
        ...openState,
        ...findings,
        pageReachable: true
      }, this.now()))
      await this._evidence(auditId, 'Buyer contact paths mapped')
      let current = await this.store.update(auditId, record => transitionWebsiteAudit(record, 'testing', {
        message: findings.chatAvailable ? 'Testing available instant website chat' : 'Evaluating mapped website journey without submitting forms'
      }, this.now()))

      if (!findings.chatAvailable) {
        const score = calculateWebsiteAuditScore(current.observations)
        const final = await this.store.update(auditId, record => completeWebsiteAudit(record, score, this.now()))
        await this._evidence(auditId, 'Website audit completed')
        const withEvidence = await this.store.get(auditId)
        await this._notify(withEvidence)
        return withEvidence
      }

      const attemptId = crypto.randomUUID()
      const prepared = await this.store.update(auditId, record => prepareWebsiteMessageSend(record, attemptId, this.now()))
      let sent
      try {
        sent = await this.browser.sendMessage(prepared.testMessage, { auditId, attemptId })
      } catch (error) {
        const failed = await this._error(
          auditId,
          error.code || 'website_chat_send_unconfirmed',
          'The website chat send action could not be confirmed. The worker will not retry automatically.'
        )
        await this._notify(failed)
        return failed
      }
      const sentAt = new Date(sent?.sentAt || this.now())
      await Promise.resolve(this.journal.append({
        type: 'website_browser_send_completed',
        auditId,
        attemptId,
        sentAt: sentAt.toISOString()
      }))
      current = await this.store.update(auditId, record => confirmWebsiteMessageSent(record, attemptId, sentAt))
      await this._evidence(auditId, 'Website chat question sent')

      const observation = await this.browser.observeUntil({
        audit: current,
        deadlineAt: current.deadlineAt,
        onReply: async reply => {
          const latest = await this.store.get(auditId)
          const classification = classifyFacebookReply(reply.text, { customerQuestion: latest.customerQuestion })
          await this.store.update(auditId, record => applyWebsiteReply(record, {
            text: reply.text,
            receivedAt: reply.receivedAt || this.now(),
            classification
          }))
          await this._evidence(auditId, classification.isUseful ? 'Useful website chat reply detected' : 'Website chat reply detected')
          if (!classification.isAutoAcknowledgement) await this._disclose(auditId, classification, reply.receivedAt)
          return { stop: classification.isUseful, classification }
        }
      })

      current = await this.store.get(auditId)
      const score = calculateWebsiteAuditScore(current.observations)
      if (!score) {
        const failed = await this._error(auditId, 'website_observation_incomplete', 'The website audit ended before a verified score could be calculated')
        await this._notify(failed)
        return failed
      }
      const completedAt = new Date(observation?.observedUntil || this.now())
      await this.store.update(auditId, record => completeWebsiteAudit(record, score, completedAt))
      await this._evidence(auditId, 'Website audit completed')
      const final = await this.store.get(auditId)
      await this._notify(final)
      return final
    } catch (error) {
      const failed = await this._error(
        auditId,
        error.code || 'website_worker_error',
        error.publicMessage || 'The website audit worker encountered an operational error'
      )
      if (failed) await this._notify(failed)
      return failed
    } finally {
      await this.browser.closeAudit?.().catch(() => {})
    }
  }
}

module.exports = { WebsiteAuditWorker }
