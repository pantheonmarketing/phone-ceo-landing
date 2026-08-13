const crypto = require('node:crypto')
const { WEBSITE_RESPONSE_MS, verifyReportToken } = require('./website-audit')

const TERMINAL_STATUSES = new Set(['completed', 'error'])
const POST_TERMINAL_EVENTS = new Set(['notification_failed', 'audit_disclosed', 'audit_disclosure_failed'])
const ALLOWED_TRANSITIONS = {
  queued: new Set(['starting', 'error']),
  starting: new Set(['mapping', 'error']),
  mapping: new Set(['testing', 'error']),
  testing: new Set(['waiting', 'completed', 'error']),
  waiting: new Set(['completed', 'error']),
  completed: new Set(),
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
  record.events.push({ eventId: crypto.randomUUID(), type, at: iso(at), ...clone(details) })
}

function createWebsiteAuditRecord(audit, reportTokenHash) {
  const record = {
    schemaVersion: 1,
    version: 1,
    auditType: 'website',
    auditId: audit.auditId,
    reportTokenHash,
    businessName: audit.businessName,
    websiteUrl: audit.websiteUrl,
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
    sendGuard: { state: 'available', attemptId: null, preparedAt: null, sentAt: null },
    disclosure: { state: 'pending', sentAt: null },
    observations: {
      pageReachable: false,
      pageLoadMs: null,
      finalUrl: null,
      contactMethods: [],
      contactClicks: null,
      contactFormFieldCount: 0,
      bookingAvailable: false,
      mobileFriendly: null,
      chatAvailable: false,
      chatProvider: null,
      messageSent: false,
      responseSeconds: null,
      usefulReply: false,
      qualificationQuestion: false,
      clearNextAction: false
    },
    replies: [],
    evidence: [],
    score: null,
    error: null,
    events: []
  }
  appendEvent(record, 'submitted', { status: 'queued', message: 'Authorized website audit submitted' }, audit.requestedAt)
  return record
}

function transitionWebsiteAudit(audit, nextStatus, details = {}, at = new Date()) {
  const record = clone(audit)
  if (!ALLOWED_TRANSITIONS[record.status]?.has(nextStatus)) {
    throw new Error(`Invalid website audit transition: ${record.status} -> ${nextStatus}`)
  }
  const atIso = iso(at)
  record.status = nextStatus
  record.updatedAt = atIso
  if (nextStatus === 'starting' && details.workerId) record.claimedBy = String(details.workerId).slice(0, 120)
  if (nextStatus === 'error') {
    record.score = null
    record.completedAt = atIso
    record.error = {
      code: String(details.code || 'website_audit_error').slice(0, 120),
      message: String(details.message || 'The website audit could not be completed').slice(0, 500),
      at: atIso
    }
  }
  appendEvent(record, nextStatus, { status: nextStatus, ...clone(details) }, at)
  return record
}

function recordWebsiteEvent(audit, type, details = {}, at = new Date()) {
  const record = clone(audit)
  if (TERMINAL_STATUSES.has(record.status) && !POST_TERMINAL_EVENTS.has(type)) {
    throw new Error(`Cannot record ${type} after terminal status ${record.status}`)
  }
  appendEvent(record, type, details, at)
  record.updatedAt = iso(at)
  return record
}

function recordWebsiteFindings(audit, findings = {}, at = new Date()) {
  const record = clone(audit)
  if (!['mapping', 'testing'].includes(record.status)) throw new Error('Website findings require an active inspection')
  const safe = {
    pageReachable: findings.pageReachable === true,
    pageLoadMs: Number.isFinite(findings.pageLoadMs) ? Math.max(0, Math.round(findings.pageLoadMs)) : record.observations.pageLoadMs,
    finalUrl: findings.finalUrl ? String(findings.finalUrl).slice(0, 1000) : record.observations.finalUrl,
    contactMethods: [...new Set((findings.contactMethods || []).map(value => String(value).slice(0, 60)))],
    contactClicks: Number.isFinite(findings.contactClicks) ? Math.max(0, Math.round(findings.contactClicks)) : null,
    contactFormFieldCount: Number.isFinite(findings.contactFormFieldCount) ? Math.max(0, Math.round(findings.contactFormFieldCount)) : 0,
    bookingAvailable: findings.bookingAvailable === true,
    mobileFriendly: typeof findings.mobileFriendly === 'boolean' ? findings.mobileFriendly : null,
    chatAvailable: findings.chatAvailable === true,
    chatProvider: findings.chatProvider ? String(findings.chatProvider).slice(0, 80) : null
  }
  record.observations = { ...record.observations, ...safe }
  record.updatedAt = iso(at)
  appendEvent(record, 'contact_paths_mapped', {
    status: record.status,
    contactMethods: safe.contactMethods,
    contactClicks: safe.contactClicks,
    contactFormFieldCount: safe.contactFormFieldCount,
    message: safe.chatAvailable ? 'Contact paths mapped; instant chat is available' : 'Contact paths mapped; no usable instant chat was found'
  }, at)
  return record
}

function prepareWebsiteMessageSend(audit, attemptId, at = new Date()) {
  const record = clone(audit)
  if (record.status !== 'testing' || !record.observations.chatAvailable) throw new Error('Website chat send can only be prepared when chat is available')
  if (record.sendGuard.state !== 'available') throw new Error('A website chat send has already been prepared')
  const value = String(attemptId || '').trim()
  if (!value) throw new Error('A send attempt ID is required')
  const atIso = iso(at)
  record.sendGuard = { state: 'prepared', attemptId: value, preparedAt: atIso, sentAt: null }
  record.updatedAt = atIso
  appendEvent(record, 'message_prepared', { status: 'testing', attemptId: value, message: 'Single-send website chat guard armed' }, at)
  return record
}

function confirmWebsiteMessageSent(audit, attemptId, sentAt = new Date()) {
  const record = clone(audit)
  if (record.status !== 'testing' || record.sendGuard.state !== 'prepared' || record.sendGuard.attemptId !== attemptId) {
    throw new Error('Website chat send confirmation does not match the prepared attempt')
  }
  const sentAtIso = iso(sentAt)
  if (new Date(sentAtIso).getTime() < new Date(record.sendGuard.preparedAt).getTime()) throw new Error('Confirmed send cannot predate send preparation')
  record.status = 'waiting'
  record.sentAt = sentAtIso
  record.deadlineAt = new Date(new Date(sentAtIso).getTime() + WEBSITE_RESPONSE_MS).toISOString()
  record.updatedAt = sentAtIso
  record.sendGuard = { ...record.sendGuard, state: 'sent', sentAt: sentAtIso }
  record.observations.messageSent = true
  appendEvent(record, 'message_sent', {
    status: 'waiting',
    sentAt: sentAtIso,
    deadlineAt: record.deadlineAt,
    message: 'One buyer question sent through website chat; 60-second clock started'
  }, sentAt)
  return record
}

function applyWebsiteReply(audit, observation) {
  const record = clone(audit)
  if (record.status !== 'waiting' || !record.sentAt) throw new Error('Website replies require a confirmed chat send')
  const receivedAt = iso(observation.receivedAt)
  if (new Date(receivedAt).getTime() < new Date(record.sentAt).getTime()) throw new Error('A reply cannot predate the confirmed send')
  const classification = clone(observation.classification || {})
  const reply = {
    replyId: crypto.randomUUID(),
    text: String(observation.text || '').trim().slice(0, 2000),
    receivedAt,
    classification
  }
  record.replies.push(reply)
  record.firstReplyAt ||= receivedAt
  if (record.firstReplyAt) {
    record.observations.responseSeconds = Math.max(0, Math.ceil((new Date(record.firstReplyAt) - new Date(record.sentAt)) / 1000))
  }
  if (classification.isUseful) record.usefulReplyAt ||= receivedAt
  record.observations.usefulReply ||= Boolean(classification.isUseful)
  record.observations.qualificationQuestion ||= Boolean(classification.hasQualificationQuestion)
  record.observations.clearNextAction ||= Boolean(classification.hasClearNextAction || classification.hasBookingCta)
  record.updatedAt = receivedAt
  appendEvent(record, 'reply_detected', { status: 'waiting', receivedAt, text: reply.text, classification }, receivedAt)
  return record
}

function completeWebsiteAudit(audit, score, at = new Date()) {
  const record = clone(audit)
  if (!['testing', 'waiting'].includes(record.status)) throw new Error('Website audit can only complete after testing')
  if (!score || !Number.isFinite(score.total) || !score.grade) throw new Error('A verified website score is required')
  const atIso = iso(at)
  record.status = 'completed'
  record.score = clone(score)
  record.completedAt = atIso
  record.updatedAt = atIso
  if (!record.sentAt && record.sendGuard.state === 'available') record.sendGuard.state = 'not_available'
  appendEvent(record, 'completed', { status: 'completed', score: clone(score), message: score.label }, at)
  return record
}

function addWebsiteEvidence(audit, evidence, at = new Date()) {
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

function publicWebsiteAuditView(audit, reportToken) {
  if (!audit || !verifyReportToken(reportToken, audit.reportTokenHash)) return null
  return {
    auditId: audit.auditId,
    auditType: 'website',
    businessName: audit.businessName,
    websiteUrl: audit.websiteUrl,
    customerQuestion: audit.customerQuestion,
    requestedAt: audit.requestedAt,
    updatedAt: audit.updatedAt,
    status: audit.status,
    sentAt: audit.sentAt,
    deadlineAt: audit.deadlineAt,
    firstReplyAt: audit.firstReplyAt,
    usefulReplyAt: audit.usefulReplyAt,
    completedAt: audit.completedAt,
    score: audit.score,
    observations: clone(audit.observations),
    replies: clone(audit.replies),
    error: clone(audit.error),
    events: audit.events.map(({ eventId, type, at, status, message, classification }) => ({
      eventId, type, at, status: status || null, message: message || null, classification: classification || null
    }))
  }
}

module.exports = {
  ALLOWED_TRANSITIONS,
  addWebsiteEvidence,
  applyWebsiteReply,
  completeWebsiteAudit,
  confirmWebsiteMessageSent,
  createWebsiteAuditRecord,
  prepareWebsiteMessageSend,
  publicWebsiteAuditView,
  recordWebsiteEvent,
  recordWebsiteFindings,
  transitionWebsiteAudit
}
