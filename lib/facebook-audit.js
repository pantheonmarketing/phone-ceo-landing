const crypto = require('node:crypto')

const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'www.fb.com'])
const TWO_MINUTES_MS = 120000

function clean(value, max) {
  return String(value || '').trim().slice(0, max)
}

function normalizeFacebookPageUrl(value) {
  const raw = clean(value, 500)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter a valid Facebook Page URL')
  }

  if (url.protocol !== 'https:' || !FACEBOOK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Enter a valid Facebook Page URL')
  }

  if (!url.pathname || url.pathname === '/') {
    throw new Error('Enter a Facebook Page URL, not the Facebook homepage')
  }

  if (url.pathname.toLowerCase() === '/profile.php') {
    const pageId = clean(url.searchParams.get('id'), 40)
    if (!/^\d+$/.test(pageId)) throw new Error('Enter a valid Facebook Page URL')
    url.search = `?id=${pageId}`
  } else {
    url.search = ''
  }
  url.hash = ''
  return url.toString()
}

function auditId() {
  return `FBA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

function createReportToken() {
  return crypto.randomBytes(24).toString('hex')
}

function hashReportToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function verifyReportToken(token, expectedHash) {
  if (!token || !/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) return false
  const actual = Buffer.from(hashReportToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function buildAuditRequest(input, now = new Date()) {
  if (!input || input.authorized !== true) {
    throw new Error('You must confirm authorization before we can send a test')
  }

  const pageUrl = normalizeFacebookPageUrl(input.pageUrl)
  const businessName = clean(input.businessName, 160) || 'This business'
  const customerQuestion = clean(input.customerQuestion, 500) || 'Hi, I am interested in your service. Can you tell me the price and availability?'
  const auditIdValue = auditId()
  const requestedAt = now.toISOString()
  const testMessage = `${customerQuestion}\n\nThis is an authorized customer-response audit for ${businessName}. Audit ID: ${auditIdValue}.`

  return {
    auditId: auditIdValue,
    pageUrl,
    businessName,
    customerQuestion,
    testMessage,
    requestedAt,
    deadlineAt: null
  }
}

function scoreFacebookAudit({
  sentAtMs,
  usefulReplyAtMs,
  observedUntilMs,
  channelReachable = false,
  autoAcknowledged = false
}, deadlineMs = TWO_MINUTES_MS) {
  if (!Number.isFinite(sentAtMs)) {
    return {
      grade: null,
      passed: null,
      label: 'Audit not scored because no test message was sent',
      responseSeconds: null,
      behaviorBand: null,
      behaviorLabel: null
    }
  }

  const responseMs = Number.isFinite(usefulReplyAtMs) ? usefulReplyAtMs - sentAtMs : null
  if (Number.isFinite(responseMs) && responseMs <= deadlineMs) {
    const responseSeconds = Math.max(0, Math.round(responseMs / 1000))
    const grade = responseMs <= 60000 ? 'A' : 'B'
    const secondsLabel = `${responseSeconds} ${responseSeconds === 1 ? 'second' : 'seconds'}`
    return {
      grade,
      passed: true,
      label: `Useful answer in ${secondsLabel}`,
      responseSeconds,
      behaviorBand: grade,
      behaviorLabel: grade === 'A' ? 'Useful answer within 60 seconds' : 'Useful answer between 61 and 120 seconds'
    }
  }

  if (!Number.isFinite(observedUntilMs) || observedUntilMs - sentAtMs < deadlineMs) {
    return {
      grade: null,
      passed: null,
      label: 'Waiting for a useful answer',
      responseSeconds: null,
      behaviorBand: null,
      behaviorLabel: null
    }
  }

  let behaviorBand = 'F'
  let behaviorLabel = 'No useful answer was observed'
  if (autoAcknowledged) {
    behaviorBand = 'C'
    behaviorLabel = 'Generic auto-reply only'
  } else if (channelReachable) {
    behaviorBand = 'D'
    behaviorLabel = 'Channel reachable, but no acknowledgement or useful answer'
  }

  return {
    grade: 'F',
    passed: false,
    label: 'No useful answer within 2 minutes',
    responseSeconds: null,
    behaviorBand,
    behaviorLabel
  }
}

const AUTO_ACK_PATTERNS = [
  /thanks? for (contacting|reaching out|your message)/i,
  /(we|i) (have )?received your message/i,
  /(we|someone|a member of our team) (will|shall) (reply|respond|get back)/i,
  /outside (our )?(business|opening) hours/i,
  /automated (reply|response|message)/i,
  /away message/i
]

function classifyFacebookReply(value, { customerQuestion = '' } = {}) {
  const text = clean(value, 2000)
  const lower = text.toLowerCase()
  const question = String(customerQuestion || '').toLowerCase()
  const isAutoAcknowledgement = AUTO_ACK_PATTERNS.some(pattern => pattern.test(text))
  const hasQualificationQuestion = /\?/.test(text) && /\b(what|which|when|where|who|how|would|could|do you|are you|your budget|how many)\b/i.test(text)
  const hasBookingCta = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|call us|give us a call)\b/i.test(text)
  const hasExplicitActionPhrase = /\b(?:click|visit|come in)\s+(?:here|below|our|us|the)\b|\b(?:send|share)\s+(?:your|us|the|a|an)\b|\breply with\b|\bmessage us\b|\bconfirm\s+(?:your|the|a|an)\b/i.test(text)
  const hasClearNextAction = hasBookingCta || hasExplicitActionPhrase
  const actionSeekingQuestion = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|call|contact|message|next step|how do i|how can i)\b/i.test(question)
  const asksCancellation = /\b(cancel|cancellation|refund|reschedul|change|modify)\b/i.test(question)
  const asksBooking = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|availab|slot)\b/i.test(question)
  const replyAddressesCancellation = /\b(cancel|cancellation|refunds?|reschedul|change|modify)\b/i.test(lower)
  const replyAddressesBooking = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|availab|slot)\b/i.test(lower)
  const actionIsRelevant = asksCancellation ? replyAddressesCancellation : asksBooking && replyAddressesBooking
  const cancellationTarget = /\b(cancel|cancellation|refunds?|reschedul|changes?|modify|appointment|booking|reservation)\b/i
  const hasCancellationProcedure = /\b(call|contact|email|message|write|submit|request)\b/i.test(lower) && cancellationTarget.test(lower)
  const hasCancellationDetail =
    /\b(full|partial|no|non[- ]?refundable|refundable)\s+refunds?\b/i.test(lower) ||
    /\brefunds?\s+(?:are|is|can be|will be|may be)\s+(?:available|offered|provided|issued|processed|allowed|permitted)\b/i.test(lower) ||
    /\b(?:cancellations?|changes?|reschedulings?)\s+(?:are|is|can be|will be|may be)\s+(?:allowed|permitted|available|free)\b/i.test(lower) ||
    /\b(?:fee|charge|deposit|credit|eligible)\b.{0,80}\b(?:refunds?|cancellations?|cancel|reschedul|changes?)\b/i.test(lower) ||
    /\b(?:refunds?|cancellations?|cancel|reschedul|changes?)\b.{0,80}\b(?:fee|charge|deposit|credit|eligible)\b/i.test(lower) ||
    /\b(?:within|before|after)\s+\d+\s+(?:days?|hours?|weeks?)\b/i.test(lower) ||
    /\b(?:we|our policy|the business)\s+(?:offer|provide|give)\s+(?:full|partial|no)?\s*refunds?\b/i.test(lower) ||
    /\bfree\s+(cancellations?|changes?|reschedulings?)\b/i.test(lower)

  const answerChecks = []
  if (/availab|open|slot|when|this week|today|tomorrow/.test(question)) {
    answerChecks.push(/\b(available|availability|open|closed|booked|slot|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i)
  }
  if (/cost|price|how much|rate|fee/.test(question)) {
    const hasNumericPricing = /(?:[$€£฿]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|thb|dollars?|baht|per person|per night|each)\b)/i.test(text)
    const hasPricingTerms = /\b(?:free|complimentary|included|no charge)\b/i.test(text)
    const hasPricingExplanation = /\b(?:price|prices|cost|costs|rate|rates|fee|fees|pricing)\b.{0,40}\b(?:vary|varies|depend|depends|range|start|starts|included)\b/i.test(text)
    answerChecks.push(() => hasNumericPricing || hasPricingTerms || hasPricingExplanation)
  }
  if (/do you|can you|offer|provide|have you/.test(question)) {
    answerChecks.push(/\b(yes|no|we do|we don't|we can|we cannot|we offer|we provide)\b/i)
  }
  if (asksCancellation) {
    answerChecks.push(() => replyAddressesCancellation && (hasCancellationProcedure || hasCancellationDetail))
  }
  const answersQuestion = answerChecks.length > 0 && answerChecks.some(check =>
    typeof check === 'function' ? check(text) : check.test(text)
  )

  const isUseful = Boolean(text) && !isAutoAcknowledgement && (
    answersQuestion ||
    (!asksCancellation && actionSeekingQuestion && actionIsRelevant && (hasQualificationQuestion || hasBookingCta || hasExplicitActionPhrase))
  )

  return {
    isAutoAcknowledgement,
    isUseful,
    hasQualificationQuestion,
    hasBookingCta,
    hasClearNextAction,
    answersQuestion
  }
}

module.exports = {
  TWO_MINUTES_MS,
  buildAuditRequest,
  classifyFacebookReply,
  createReportToken,
  hashReportToken,
  normalizeFacebookPageUrl,
  scoreFacebookAudit,
  verifyReportToken
}
