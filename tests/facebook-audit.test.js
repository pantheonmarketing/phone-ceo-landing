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

test('Facebook Page URLs reject embedded credentials', () => {
  assert.throws(
    () => normalizeFacebookPageUrl('https://alice:secret@www.facebook.com/examplebusiness'),
    /cannot contain credentials/
  )
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

test('scoreFacebookAudit gives a B when the exact response time exceeds one minute', () => {
  const result = scoreFacebookAudit({ sentAtMs: 0, usefulReplyAtMs: 60400 }, 120000)

  assert.equal(result.grade, 'B')
  assert.equal(result.passed, true)
  assert.equal(result.responseSeconds, 61)
  assert.equal(result.label, 'Useful answer in 61 seconds')

  const later = scoreFacebookAudit({ sentAtMs: 0, usefulReplyAtMs: 119500 }, 120000)
  assert.equal(later.grade, 'B')
  assert.equal(later.responseSeconds, 120)
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

  const generic = classifyFacebookReply('Yes.', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(generic.answersQuestion, false)
  assert.equal(generic.isUseful, false)

  const genericFiller = classifyFacebookReply('Yes, we can help.', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(genericFiller.answersQuestion, false)
  assert.equal(genericFiller.isUseful, false)

  const echoedOffer = classifyFacebookReply('Yes, we offer private events.', {
    customerQuestion: 'Do you offer private events?'
  })
  assert.equal(echoedOffer.answersQuestion, false)
  assert.equal(echoedOffer.isUseful, false)

  const partial = classifyFacebookReply('Yes, we have a table Friday at 7pm.', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(partial.isUseful, true)
  assert.equal(partial.answersQuestion, true)

  const useful = classifyFacebookReply('Yes, we have a table Friday at 7pm. It is $65 per person. Would you like me to reserve it?', {
    customerQuestion: 'Do you have availability this week and what does it cost?'
  })
  assert.equal(useful.isAutoAcknowledgement, false)
  assert.equal(useful.isUseful, true)
  assert.equal(useful.hasQualificationQuestion, true)
  assert.equal(useful.hasBookingCta, true)
  assert.equal(useful.hasClearNextAction, true)

  const acknowledgedUseful = classifyFacebookReply('Thanks for contacting us. Our price is $50.', {
    customerQuestion: 'What does it cost?'
  })
  assert.equal(acknowledgedUseful.isAutoAcknowledgement, true)
  assert.equal(acknowledgedUseful.answersQuestion, true)
  assert.equal(acknowledgedUseful.isUseful, true)

  const unrelated = classifyFacebookReply('We are open.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(unrelated.isUseful, false)
  assert.equal(unrelated.hasClearNextAction, false)

  const unrelatedOffer = classifyFacebookReply('Yes, we are open.', {
    customerQuestion: 'Do you offer private events?'
  })
  assert.equal(unrelatedOffer.answersQuestion, false)
  assert.equal(unrelatedOffer.isUseful, false)

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

test('classifyFacebookReply rejects generic pricing and echoed cancellation policy phrases', () => {
  const echoedPrice = classifyFacebookReply('Our price is our price.', {
    customerQuestion: 'What does it cost?'
  })
  assert.equal(echoedPrice.answersQuestion, false)
  assert.equal(echoedPrice.isUseful, false)

  const vaguePricing = classifyFacebookReply('Our pricing varies.', {
    customerQuestion: 'What does it cost?'
  })
  assert.equal(vaguePricing.answersQuestion, false)
  assert.equal(vaguePricing.isUseful, false)

  const echoedRefund = classifyFacebookReply('Our refund policy is to book now through our calendar.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(echoedRefund.answersQuestion, false)
  assert.equal(echoedRefund.isUseful, false)

  const vagueRefundProcedure = classifyFacebookReply('Our refund policy is to contact us.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(vagueRefundProcedure.answersQuestion, false)
  assert.equal(vagueRefundProcedure.isUseful, false)

  const usefulRefund = classifyFacebookReply('Refunds are available within 7 days of purchase.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(usefulRefund.answersQuestion, true)
  assert.equal(usefulRefund.isUseful, true)

  const vagueRefund = classifyFacebookReply('We are available to answer your refund questions.', {
    customerQuestion: 'What is your refund policy?'
  })
  assert.equal(vagueRefund.answersQuestion, false)
  assert.equal(vagueRefund.isUseful, false)

  const genericRefund = classifyFacebookReply('Yes.', {
    customerQuestion: 'Do you offer refunds?'
  })
  assert.equal(genericRefund.answersQuestion, false)
  assert.equal(genericRefund.isUseful, false)

  const contactAction = classifyFacebookReply('Message us.', {
    customerQuestion: 'How can I contact you?'
  })
  assert.equal(contactAction.answersQuestion, false)
  assert.equal(contactAction.isUseful, true)

  const vagueRefundConfirmation = classifyFacebookReply('Yes, we offer refunds.', {
    customerQuestion: 'Do you offer refunds?'
  })
  assert.equal(vagueRefundConfirmation.answersQuestion, false)
  assert.equal(vagueRefundConfirmation.isUseful, false)
})
