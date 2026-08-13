const crypto = require('node:crypto')
const {
  TWO_MINUTES_MS,
  calculateNumericFacebookAuditScore,
  verifyReportToken
} = require('./facebook-audit')

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error'])
const POST_TERMINAL_EVENT_TYPES = new Set([
  'audit_disclosed',
  'audit_disclosure_failed',
  'notification_failed',
  'late_reply_monitoring',
  'late_reply_window_closed',
  'late_reply_monitor_error'
])
const ALLOWED_TRANSITIONS = {
  queued: new Set(['starting', 'error']),
  starting: new Set(['message_sent', 'error']),
  message_sent: new Set(['waiting', 'error']),
  waiting: new Set(['passed', 'failed', 'error']),
  passed: new Set(),
  failed: new Set(),
  error: new Set()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('A valid event timestamp is required')
  return date.toISOString()
}

function appendEvent(record, type, details = {}, at = new Date()) {
  record.events.push({
    eventId: crypto.randomUUID(),
    type,
    at: iso(at),
    ...clone(details)
  })
}

function createAuditRecord(audit, reportTokenHash) {
  const record = {
    schemaVersion: 1,
    version: 1,
    auditId: audit.auditId,
    reportTokenHash,
    businessName: audit.businessName,
    pageUrl: audit.pageUrl,
    customerQuestion: audit.customerQuestion,
    testMessage: audit.testMessage,
    disclosureMessage: audit.disclosureMessage,
    authorized: true,
    authorizationConfirmedAt: audit.requestedAt,
    requestedAt: audit.requestedAt,
    updatedAt: audit.requestedAt,
    status: 'queued',
    claimedBy: null,
    sentAt: null,
    deadlineAt: null,
    firstReplyAt: null,
    usefulReplyAt: null,
    completedAt: null,
    sendGuard: {
      state: 'available',
      attemptId: null,
      preparedAt: null,
      sentAt: null
    },
    disclosure: {
      state: 'pending',
      sentAt: null
    },
    observations: {
      channelReachable: false,
      autoAcknowledged: false,
      qualificationQuestion: false,
      bookingCta: false,
      clearNextAction: false
    },
    replies: [],
    evidence: [],
    score: null,
    error: null,
    events: []
  }
  appendEvent(record, 'submitted', { status: 'queued', message: 'Authorized audit submitted' }, audit.requestedAt)
  return record
}

function recordAuditEvent(audit, type, details = {}, at = new Date()) {
  const record = clone(audit)
  if (TERMINAL_STATUSES.has(record.status) && !POST_TERMINAL_EVENT_TYPES.has(type)) {
    throw new Error(`Cannot record ${type} after terminal status ${record.status}`)
  }
  appendEvent(record, type, details, at)
  record.updatedAt = iso(at)
  return record
}

function transitionAudit(audit, nextStatus, details = {}, at = new Date()) {
  const record = clone(audit)
  if ((nextStatus === 'passed' || nextStatus === 'failed') && !record.sentAt) {
    throw new Error('Cannot score an audit unless a test message was sent')
  }
  if (!ALLOWED_TRANSITIONS[record.status] || !ALLOWED_TRANSITIONS[record.status].has(nextStatus)) {
    throw new Error(`Invalid audit transition: ${record.status} -> ${nextStatus}`)
  }

  if (nextStatus === 'passed' && (!details.score || !['A', 'B'].includes(details.score.grade))) {
    throw new Error('Passed audits require an A or B score')
  }
  if (nextStatus === 'failed' && (!details.score || details.score.grade !== 'F')) {
    throw new Error('Failed audits require an F score')
  }

  const atIso = iso(at)
  record.status = nextStatus
  record.updatedAt = atIso
  if (nextStatus === 'starting' && details.workerId) record.claimedBy = String(details.workerId).slice(0, 120)
  if (details.score) record.score = clone(details.score)
  if (TERMINAL_STATUSES.has(nextStatus)) record.completedAt = atIso
  if (nextStatus === 'error') {
    record.score = null
    record.error = {
      code: String(details.code || 'audit_error').slice(0, 120),
      message: String(details.message || 'The audit could not be completed').slice(0, 500),
      at: atIso
    }
  }
  appendEvent(record, nextStatus, { status: nextStatus, ...clone(details), score: details.score || undefined }, at)
  return record
}

function prepareMessageSend(audit, attemptId, at = new Date()) {
  const record = clone(audit)
  if (record.status !== 'starting') throw new Error('Message send can only be prepared while starting')
  if (record.sendGuard.state !== 'available') throw new Error('A message send has already been prepared for this audit')
  const value = String(attemptId || '').trim()
  if (!value) throw new Error('A send attempt ID is required')
  const atIso = iso(at)
  record.sendGuard = { state: 'prepared', attemptId: value, preparedAt: atIso, sentAt: null }
  record.updatedAt = atIso
  appendEvent(record, 'message_prepared', { status: 'starting', attemptId: value, message: 'Single-send guard armed' }, at)
  return record
}

function confirmMessageSent(audit, attemptId, sentAt = new Date()) {
  const record = clone(audit)
  if (record.status !== 'starting') throw new Error('Message send can only be confirmed while starting')
  if (record.sendGuard.state !== 'prepared') throw new Error('Message send was not prepared')
  if (record.sendGuard.attemptId !== attemptId) throw new Error('Send attempt does not match the prepared attempt')
  const sentAtIso = iso(sentAt)
  if (new Date(sentAtIso).getTime() < new Date(record.sendGuard.preparedAt).getTime()) {
    throw new Error('Confirmed send cannot predate send preparation')
  }
  const deadlineAt = new Date(new Date(sentAtIso).getTime() + TWO_MINUTES_MS).toISOString()
  record.status = 'message_sent'
  record.sentAt = sentAtIso
  record.deadlineAt = deadlineAt
  record.updatedAt = sentAtIso
  record.sendGuard.state = 'sent'
  record.sendGuard.sentAt = sentAtIso
  record.observations.channelReachable = true
  appendEvent(record, 'message_sent', { status: 'message_sent', sentAt: sentAtIso, deadlineAt, message: 'Audit message sent; two-minute clock started' }, sentAt)
  return record
}

function reconcileAmbiguousSend(audit, {
  sentAt,
  observedUntil,
  score,
  evidenceBasis
} = {}) {
  const record = clone(audit)
  if (record.status !== 'error' || record.error?.code !== 'send_ambiguous') {
    throw new Error('Only an ambiguous-send error can be reconciled')
  }
  if (record.sendGuard?.state !== 'prepared' || !record.sendGuard.attemptId) {
    throw new Error('Ambiguous-send reconciliation requires a prepared single-send guard')
  }
  const basis = String(evidenceBasis || '').trim()
  if (!basis) throw new Error('An evidence basis is required to reconcile an ambiguous send')
  if (!score || score.grade !== 'F' || score.passed !== false) {
    throw new Error('Ambiguous-send reconciliation requires an F score')
  }

  const sentAtIso = iso(sentAt)
  const observedUntilIso = iso(observedUntil)
  const preparedMs = new Date(record.sendGuard.preparedAt).getTime()
  const previousErrorMs = new Date(record.error.at).getTime()
  const sentAtMs = new Date(sentAtIso).getTime()
  const observedUntilMs = new Date(observedUntilIso).getTime()
  if (sentAtMs < preparedMs || sentAtMs > previousErrorMs) {
    throw new Error('Reconciled send time must stay inside the recorded send-attempt window')
  }
  const deadlineAt = new Date(sentAtMs + TWO_MINUTES_MS).toISOString()
  if (observedUntilMs < new Date(deadlineAt).getTime()) {
    throw new Error('Reconciliation must observe the full two-minute deadline')
  }

  const previousError = clone(record.error)
  record.status = 'failed'
  record.sentAt = sentAtIso
  record.deadlineAt = deadlineAt
  record.completedAt = observedUntilIso
  record.updatedAt = observedUntilIso
  record.sendGuard.state = 'sent'
  record.sendGuard.sentAt = sentAtIso
  record.observations.channelReachable = true
  record.score = clone(score)
  record.error = null
  record.sendReconciliation = {
    conservativeLatestBound: true,
    sendWindowStart: record.sendGuard.preparedAt,
    sendWindowEnd: previousError.at,
    effectiveSentAt: sentAtIso,
    observedUntil: observedUntilIso,
    evidenceBasis: basis.slice(0, 500),
    previousError
  }
  appendEvent(record, 'message_sent_reconciled', {
    status: 'message_sent',
    sentAt: sentAtIso,
    deadlineAt,
    message: 'Facebook delivery was visually confirmed after the original confirmation timeout; the latest possible send time was used conservatively'
  }, observedUntil)
  appendEvent(record, 'failed', {
    status: 'failed',
    score: clone(score),
    message: score.label
  }, observedUntil)
  return record
}

function applyReplyObservation(audit, observation) {
  const record = clone(audit)
  if (!['message_sent', 'waiting'].includes(record.status)) throw new Error('Replies can only be recorded after a message was sent')
  const receivedAt = iso(observation.receivedAt)
  if (new Date(receivedAt).getTime() < new Date(record.sentAt).getTime()) {
    throw new Error('A reply cannot predate the confirmed send')
  }
  const classification = clone(observation.classification || {})
  const reply = {
    replyId: crypto.randomUUID(),
    text: String(observation.text || '').trim().slice(0, 2000),
    receivedAt,
    classification
  }
  record.replies.push(reply)
  record.firstReplyAt ||= receivedAt
  if (classification.isUseful) record.usefulReplyAt ||= receivedAt
  record.observations.autoAcknowledged ||= Boolean(classification.isAutoAcknowledgement)
  record.observations.qualificationQuestion ||= Boolean(classification.hasQualificationQuestion)
  record.observations.bookingCta ||= Boolean(classification.hasBookingCta)
  record.observations.clearNextAction ||= Boolean(classification.hasClearNextAction)
  record.updatedAt = receivedAt
  appendEvent(record, 'reply_detected', {
    status: record.status,
    receivedAt,
    text: reply.text,
    classification
  }, receivedAt)
  return record
}

function applyLateReplyObservation(audit, observation) {
  const record = clone(audit)
  if (record.status !== 'failed' || record.score?.grade !== 'F' || !record.deadlineAt) {
    throw new Error('Late replies can only be recorded for a completed F audit')
  }
  const receivedAt = iso(observation.receivedAt)
  const receivedAtMs = new Date(receivedAt).getTime()
  const deadlineAtMs = new Date(record.deadlineAt).getTime()
  if (receivedAtMs <= deadlineAtMs) throw new Error('A late reply must arrive after the two-minute deadline')
  const classification = clone(observation.classification || {})
  const reply = {
    replyId: crypto.randomUUID(),
    text: String(observation.text || '').trim().slice(0, 2000),
    receivedAt,
    isLate: true,
    secondsAfterDeadline: Math.max(1, Math.ceil((receivedAtMs - deadlineAtMs) / 1000)),
    timestampSource: String(observation.timestampSource || 'worker_first_seen').slice(0, 80),
    timestampPrecision: String(observation.timestampPrecision || 'millisecond').slice(0, 40),
    classification
  }
  if (!reply.text) throw new Error('A late reply must include message text')
  record.replies.push(reply)
  record.firstReplyAt ||= receivedAt
  if (classification.isUseful) record.usefulReplyAt ||= receivedAt
  record.observations.autoAcknowledged ||= Boolean(classification.isAutoAcknowledgement)
  record.observations.qualificationQuestion ||= Boolean(classification.hasQualificationQuestion)
  record.observations.bookingCta ||= Boolean(classification.hasBookingCta)
  record.observations.clearNextAction ||= Boolean(classification.hasClearNextAction)
  record.updatedAt = receivedAt
  appendEvent(record, 'late_reply_detected', {
    status: record.status,
    receivedAt,
    secondsAfterDeadline: reply.secondsAfterDeadline,
    text: reply.text,
    classification,
    message: classification.isUseful
      ? 'Useful reply detected after the two-minute result deadline; grade unchanged'
      : 'Reply detected after the two-minute result deadline; grade unchanged'
  }, receivedAt)
  return record
}

function addEvidence(audit, evidence, at = new Date()) {
  const record = clone(audit)
  const item = {
    evidenceId: crypto.randomUUID(),
    type: String(evidence.type || 'screenshot').slice(0, 60),
    label: String(evidence.label || 'Evidence').slice(0, 160),
    capturedAt: iso(evidence.capturedAt || at),
    reference: String(evidence.reference || '').slice(0, 1000)
  }
  record.evidence.push(item)
  appendEvent(record, 'evidence_captured', { status: record.status, evidenceId: item.evidenceId, label: item.label }, item.capturedAt)
  record.updatedAt = item.capturedAt
  return record
}

function publicAuditView(audit, reportToken) {
  if (!audit || !verifyReportToken(reportToken, audit.reportTokenHash)) return null
  const numericBreakdown = calculateNumericFacebookAuditScore({
    customerQuestion: audit.customerQuestion,
    score: audit.score,
    observations: audit.observations,
    replies: audit.replies
  })
  const publicScore = audit.score
    ? {
        ...clone(audit.score),
        numericScore: numericBreakdown?.total ?? null,
        numericBreakdown
      }
    : null
  return {
    auditId: audit.auditId,
    businessName: audit.businessName,
    pageUrl: audit.pageUrl,
    customerQuestion: audit.customerQuestion,
    requestedAt: audit.requestedAt,
    updatedAt: audit.updatedAt,
    status: audit.status,
    sentAt: audit.sentAt,
    deadlineAt: audit.deadlineAt,
    firstReplyAt: audit.firstReplyAt,
    usefulReplyAt: audit.usefulReplyAt,
    completedAt: audit.completedAt,
    grade: audit.score?.grade || null,
    score: publicScore,
    observations: audit.observations,
    replies: audit.replies,
    sendReconciliation: audit.sendReconciliation || null,
    error: audit.error,
    events: audit.events.map(({ eventId, type, at, status, message, label, classification }) => ({
      eventId, type, at, status: status || null, message: message || null, label: label || null, classification: classification || null
    }))
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  addEvidence,
  applyLateReplyObservation,
  applyReplyObservation,
  confirmMessageSent,
  createAuditRecord,
  prepareMessageSend,
  publicAuditView,
  reconcileAmbiguousSend,
  recordAuditEvent,
  transitionAudit
}
