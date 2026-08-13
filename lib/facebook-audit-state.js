const crypto = require('node:crypto')
const { TWO_MINUTES_MS, verifyReportToken } = require('./facebook-audit')

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error'])
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
  if (TERMINAL_STATUSES.has(record.status) && type !== 'notification_failed') {
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

function applyReplyObservation(audit, observation) {
  const record = clone(audit)
  if (!['message_sent', 'waiting'].includes(record.status)) throw new Error('Replies can only be recorded after a message was sent')
  const receivedAt = iso(observation.receivedAt)
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
    score: audit.score,
    observations: audit.observations,
    replies: audit.replies,
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
  applyReplyObservation,
  confirmMessageSent,
  createAuditRecord,
  prepareMessageSend,
  publicAuditView,
  recordAuditEvent,
  transitionAudit
}
