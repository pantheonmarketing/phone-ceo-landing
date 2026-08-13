const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyReplyObservation,
  confirmMessageSent,
  createAuditRecord,
  prepareMessageSend,
  publicAuditView,
  reconcileAmbiguousSend,
  transitionAudit
} = require('../lib/facebook-audit-state')
const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')

function record() {
  const audit = buildAuditRequest({
    businessName: 'Example Business',
    pageUrl: 'https://facebook.com/examplebusiness',
    customerQuestion: 'Do you have availability and what does it cost?',
    authorized: true
  }, new Date('2026-08-13T08:00:00.000Z'))
  const reportToken = createReportToken()
  return { audit: createAuditRecord(audit, hashReportToken(reportToken)), reportToken }
}

test('audit lifecycle records exact timestamped transitions', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting', { workerId: 'worker-1' }, new Date('2026-08-13T08:00:05.000Z'))
  audit = prepareMessageSend(audit, 'attempt-1', new Date('2026-08-13T08:00:08.000Z'))
  audit = confirmMessageSent(audit, 'attempt-1', new Date('2026-08-13T08:00:10.125Z'))
  audit = transitionAudit(audit, 'waiting', {}, new Date('2026-08-13T08:00:10.200Z'))

  assert.equal(audit.status, 'waiting')
  assert.equal(audit.sentAt, '2026-08-13T08:00:10.125Z')
  assert.equal(audit.deadlineAt, '2026-08-13T08:02:10.125Z')
  assert.deepEqual(audit.events.map(event => event.type), [
    'submitted', 'starting', 'message_prepared', 'message_sent', 'waiting'
  ])
})

test('one-send guard rejects a second preparation, mismatched, or early confirmation', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting', {}, new Date('2026-08-13T08:00:01.000Z'))
  audit = prepareMessageSend(audit, 'attempt-1', new Date('2026-08-13T08:00:02.000Z'))

  assert.throws(() => prepareMessageSend(audit, 'attempt-2'), /already been prepared/i)
  assert.throws(() => confirmMessageSent(audit, 'attempt-2'), /attempt does not match/i)
  assert.throws(() => confirmMessageSent(audit, 'attempt-1', new Date('2026-08-13T08:00:01.500Z')), /predate send preparation/i)
})

test('errors before a send stay unscored and cannot be marked failed', () => {
  let { audit, reportToken } = record()
  audit = transitionAudit(audit, 'starting', {}, new Date('2026-08-13T08:00:01.000Z'))
  assert.throws(() => transitionAudit(audit, 'failed', {}), /message was sent/i)

  audit = transitionAudit(audit, 'error', { code: 'facebook_login_required' }, new Date('2026-08-13T08:00:02.000Z'))
  assert.equal(audit.score, null)
  assert.equal(audit.error.code, 'facebook_login_required')

  const view = publicAuditView(audit, reportToken)
  assert.equal(view.status, 'error')
  assert.equal(view.grade, null)
  assert.equal(view.error.code, 'facebook_login_required')
})

test('a visually confirmed ambiguous send can be reconciled conservatively after its deadline', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting', {}, new Date('2026-08-13T08:00:01.000Z'))
  audit = prepareMessageSend(audit, 'attempt-1', new Date('2026-08-13T08:00:02.000Z'))
  audit = transitionAudit(audit, 'error', {
    code: 'send_ambiguous',
    message: 'Send confirmation timed out'
  }, new Date('2026-08-13T08:00:09.000Z'))
  const score = {
    grade: 'F',
    passed: false,
    label: 'No useful answer within 2 minutes',
    responseSeconds: null,
    behaviorBand: 'D',
    behaviorLabel: 'Channel reachable, but no acknowledgement or useful answer'
  }

  audit = reconcileAmbiguousSend(audit, {
    sentAt: '2026-08-13T08:00:09.000Z',
    observedUntil: '2026-08-13T08:02:30.000Z',
    score,
    evidenceBasis: 'Facebook displayed the audit bubble as sent by the audit account'
  })

  assert.equal(audit.status, 'failed')
  assert.equal(audit.sentAt, '2026-08-13T08:00:09.000Z')
  assert.equal(audit.deadlineAt, '2026-08-13T08:02:09.000Z')
  assert.equal(audit.score.grade, 'F')
  assert.equal(audit.error, null)
  assert.equal(audit.sendGuard.state, 'sent')
  assert.equal(audit.sendReconciliation.conservativeLatestBound, true)
  assert.deepEqual(audit.events.slice(-2).map(event => event.type), ['message_sent_reconciled', 'failed'])
})

test('ambiguous-send reconciliation rejects missing proof or an observation before the deadline', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting', {}, new Date('2026-08-13T08:00:01.000Z'))
  audit = prepareMessageSend(audit, 'attempt-1', new Date('2026-08-13T08:00:02.000Z'))
  audit = transitionAudit(audit, 'error', { code: 'send_ambiguous' }, new Date('2026-08-13T08:00:09.000Z'))
  const score = { grade: 'F', passed: false, label: 'No useful answer within 2 minutes' }

  assert.throws(() => reconcileAmbiguousSend(audit, {
    sentAt: '2026-08-13T08:00:09.000Z',
    observedUntil: '2026-08-13T08:02:30.000Z',
    score
  }), /evidence basis/i)
  assert.throws(() => reconcileAmbiguousSend(audit, {
    sentAt: '2026-08-13T08:00:09.000Z',
    observedUntil: '2026-08-13T08:02:08.999Z',
    score,
    evidenceBasis: 'Visual proof'
  }), /full two-minute deadline/i)
})

test('reply observations cannot fabricate a reply before the confirmed send', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting')
  audit = prepareMessageSend(audit, 'attempt-1')
  audit = confirmMessageSent(audit, 'attempt-1', new Date('2026-08-13T08:00:03.000Z'))
  audit = transitionAudit(audit, 'waiting')
  assert.throws(() => applyReplyObservation(audit, {
    text: 'Reply',
    receivedAt: '2026-08-13T08:00:02.000Z',
    classification: { isUseful: true }
  }), /predate the confirmed send/i)
})

test('reply observations preserve first reply and first useful reply', () => {
  let { audit } = record()
  audit = transitionAudit(audit, 'starting', {}, new Date('2026-08-13T08:00:01.000Z'))
  audit = prepareMessageSend(audit, 'attempt-1', new Date('2026-08-13T08:00:02.000Z'))
  audit = confirmMessageSent(audit, 'attempt-1', new Date('2026-08-13T08:00:03.000Z'))
  audit = transitionAudit(audit, 'waiting', {}, new Date('2026-08-13T08:00:03.100Z'))
  audit = applyReplyObservation(audit, {
    text: 'Thanks for contacting us. We will reply soon.',
    receivedAt: '2026-08-13T08:00:04.000Z',
    classification: { isAutoAcknowledgement: true, isUseful: false }
  })
  audit = applyReplyObservation(audit, {
    text: 'Yes, Friday is available for $50. Would you like to book?',
    receivedAt: '2026-08-13T08:00:40.000Z',
    classification: { isAutoAcknowledgement: false, isUseful: true, hasBookingCta: true }
  })

  assert.equal(audit.firstReplyAt, '2026-08-13T08:00:04.000Z')
  assert.equal(audit.usefulReplyAt, '2026-08-13T08:00:40.000Z')
  assert.equal(audit.observations.autoAcknowledged, true)
  assert.equal(audit.observations.bookingCta, true)
  assert.equal(audit.replies.length, 2)
})
