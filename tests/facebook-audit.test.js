const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildAuditRequest,
  classifyFacebookReply,
  normalizeFacebookPageUrl,
  scoreFacebookAudit
} = require('../lib/facebook-audit')

test('buildAuditRequest accepts a Facebook Page URL and waits to create the deadline until send', () => {
  const now = new Date('2026-08-13T08:00:00.000Z')
  const result = buildAuditRequest({
    pageUrl: 'https://www.facebook.com/examplebusiness/',
    businessName: 'Example Business',
    customerQuestion: 'Hi, do you have availability this week?',
    authorized: true
  }, now)

  assert.match(result.auditId, /^FBA-[A-Z0-9]{8}$/)
  assert.equal(result.pageUrl, 'https://www.facebook.com/examplebusiness/')
  assert.equal(result.deadlineAt, null)
  assert.match(result.testMessage, /Hi, do you have availability this week\?/)
  assert.match(result.testMessage, new RegExp(result.auditId))
  assert.match(result.testMessage, /authorized customer-response audit/i)
})

test('buildAuditRequest rejects a non-Facebook URL and an unauthorized test', () => {
  assert.throws(() => buildAuditRequest({
    pageUrl: 'https://example.com',
    authorized: true
  }), /Facebook Page URL/)

  assert.throws(() => buildAuditRequest({
    pageUrl: 'https://facebook.com/examplebusiness',
    authorized: false
  }), /authorization/)
})

test('Facebook profile.php Page URLs preserve their numeric Page ID', () => {
  assert.equal(
    normalizeFacebookPageUrl('https://www.facebook.com/profile.php?id=61574382802393&utm_source=test'),
    'https://www.facebook.com/profile.php?id=61574382802393'
  )
  assert.throws(
    () => normalizeFacebookPageUrl('https://www.facebook.com/profile.php'),
    /Page URL/
  )
})

test('scoreFacebookAudit marks no useful reply by the two-minute deadline as F', () => {
  const result = scoreFacebookAudit({
    sentAtMs: 0,
    usefulReplyAtMs: null,
    observedUntilMs: 120000,
    channelReachable: true,
    autoAcknowledged: false
  }, 120000)

  assert.deepEqual(result, {
    grade: 'F',
    passed: false,
    label: 'No useful answer within 2 minutes',
    responseSeconds: null,
    behaviorBand: 'D',
    behaviorLabel: 'Channel reachable, but no acknowledgement or useful answer'
  })
})

test('scoreFacebookAudit gives an A when a useful answer arrives within one minute', () => {
  const result = scoreFacebookAudit({ sentAtMs: 0, usefulReplyAtMs: 42000 }, 120000)

  assert.deepEqual(result, {
    grade: 'A',
    passed: true,
    label: 'Useful answer in 42 seconds',
    responseSeconds: 42,
    behaviorBand: 'A',
    behaviorLabel: 'Useful answer within 60 seconds'
  })
})

test('scoreFacebookAudit gives a B for a useful answer from 61 through 120 seconds', () => {
  const result = scoreFacebookAudit({ sentAtMs: 0, usefulReplyAtMs: 119500 }, 120000)

  assert.equal(result.grade, 'B')
  assert.equal(result.passed, true)
  assert.equal(result.responseSeconds, 120)
})

test('generic auto reply alone is an F with a C diagnostic band', () => {
  const result = scoreFacebookAudit({
    sentAtMs: 0,
    usefulReplyAtMs: null,
    observedUntilMs: 120000,
    channelReachable: true,
    autoAcknowledged: true
  })

  assert.equal(result.grade, 'F')
  assert.equal(result.behaviorBand, 'C')
  assert.equal(result.passed, false)
})

test('an audit is pending before the deadline and unscored before a send', () => {
  assert.deepEqual(scoreFacebookAudit({ sentAtMs: null, observedUntilMs: 120000 }), {
    grade: null,
    passed: null,
    label: 'Audit not scored because no test message was sent',
    responseSeconds: null,
    behaviorBand: null,
    behaviorLabel: null
  })

  assert.deepEqual(scoreFacebookAudit({ sentAtMs: 0, observedUntilMs: 90000 }), {
    grade: null,
    passed: null,
    label: 'Waiting for a useful answer',
    responseSeconds: null,
    behaviorBand: null,
    behaviorLabel: null
  })
})

test('classifyFacebookReply rejects generic acknowledgements and identifies useful next steps', () => {
  const auto = classifyFacebookReply('Thanks for contacting us. We received your message and will get back to you soon.', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(auto.isAutoAcknowledgement, true)
  assert.equal(auto.isUseful, false)

  const partial = classifyFacebookReply('Yes, we have a table Friday at 7pm.', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(partial.isUseful, false)
  assert.equal(partial.answersQuestion, false)

  const useful = classifyFacebookReply('Yes, we have a table Friday at 7pm. It is $65 per person. Would you like me to reserve it?', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(useful.isAutoAcknowledgement, false)
  assert.equal(useful.isUseful, true)
  assert.equal(useful.hasQualificationQuestion, true)
  assert.equal(useful.hasBookingCta, true)
  assert.equal(useful.hasClearNextAction, true)

  const unrelated = classifyFacebookReply('We are open.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(unrelated.isUseful, false)
  assert.equal(unrelated.hasClearNextAction, false)

  const unrelatedAction = classifyFacebookReply('Book now through our calendar.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(unrelatedAction.isUseful, false)
  assert.equal(unrelatedAction.hasBookingCta, true)

  const unrelatedCancellationAction = classifyFacebookReply('Book now through our calendar.', {
    customerQuestion: 'How can I cancel my appointment?'
  })
  assert.equal(unrelatedCancellationAction.isUseful, false)

  const cancellationBookingRedirect = classifyFacebookReply('To cancel, book now through our calendar.', {
    customerQuestion: 'How can I cancel my appointment?'
  })
  assert.equal(cancellationBookingRedirect.isUseful, false)
})
