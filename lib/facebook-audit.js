const crypto = require('node:crypto')

const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'www.fb.com'])
const TWO_MINUTES_MS = 120000
const CUSTOMER_QUESTION_LANGUAGE_ERROR = 'Please rewrite the customer question without abusive or offensive language'

const ABUSIVE_LANGUAGE_PATTERNS = [
  /\bf+[\W_]*u+[\W_]*c+[\W_]*k+(?:er|ed|ing|s)?\b/i,
  /\bf+[\W_]*c+[\W_]*k+(?:er|ed|ing|s)?\b/i,
  /\bs+[\W_]*h+[\W_]*i+[\W_]*t+(?:ty|tier|tiest|head|heads|s)?\b/i,
  /\bb+[\W_]*i+[\W_]*t+[\W_]*c+[\W_]*h+(?:es|y)?\b/i,
  /\ba+[\W_]*s+[\W_]*s+[\W_]*h+[\W_]*o+[\W_]*l+[\W_]*e+(?:s)?\b/i,
  /\bc+[\W_]*u+[\W_]*n+[\W_]*t+(?:s)?\b/i,
  /\bm+[\W_]*o+[\W_]*t+[\W_]*h+[\W_]*e+[\W_]*r+[\W_]*f+[\W_]*u+[\W_]*c+[\W_]*k+(?:er|ers|ing)?\b/i,
  /\bd+[\W_]*i+[\W_]*c+[\W_]*k+[\W_]*h+[\W_]*e+[\W_]*a+[\W_]*d+(?:s)?\b/i,
  /\bb+[\W_]*u+[\W_]*l+[\W_]*l+[\W_]*s+[\W_]*h+[\W_]*i+[\W_]*t+\b/i,
  /\b(?:slut|whore|faggot|nigger|retard)(?:s|ed)?\b/i,
  /\b(?:wtf|stfu)\b/i,
  /\b(?:damn|dammit)\b/i,
  /\b(?:go|please)\s+(?:kill\s+(?:yourself|urself)|die)\b/i,
  /\bhope\s+you\s+die\b/i,
  /\b(?:i\s*(?:am|m)|we\s*(?:are|re)|gonna|going\s+to|will)\s+(?:kill|hurt|shoot)\s+you\b/i
]

function clean(value, max) {
  return String(value || '').trim().slice(0, max)
}

function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/[8]/g, 'b')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7+]/g, 't')
    .replace(/([a-z])\1{2,}/g, '$1')
}

function containsAbusiveCustomerLanguage(value) {
  const normalized = normalizeModerationText(value)
  return ABUSIVE_LANGUAGE_PATTERNS.some(pattern => pattern.test(normalized))
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
  if (url.username || url.password) {
    throw new Error('Facebook Page URLs cannot contain credentials')
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
  if (containsAbusiveCustomerLanguage(customerQuestion)) {
    throw new Error(CUSTOMER_QUESTION_LANGUAGE_ERROR)
  }
  const auditIdValue = auditId()
  const requestedAt = now.toISOString()
  const testMessage = customerQuestion
  const disclosureMessage = `Thank you for replying. This was an authorized customer-response audit for ${businessName}. Audit ID: ${auditIdValue}.`

  return {
    auditId: auditIdValue,
    pageUrl,
    businessName,
    customerQuestion,
    testMessage,
    disclosureMessage,
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
    const responseSeconds = Math.max(0, Math.ceil(responseMs / 1000))
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
  const isGenericConfirmation = /^(?:yes|no|yeah|yep|sure|okay|ok|absolutely|of course|we do|we don't|we can|we can't|not at this time|unfortunately not)[.!?\s]*$/i.test(text)
  const hasQualificationQuestion = /\?/.test(text) && /\b(what|which|when|where|who|how|would|could|do you|are you|your budget|how many)\b/i.test(text)
  const hasBookingCta = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|register|sign up|call us|give us a call)\b|\b(?:secure|claim)\s+(?:your|a|the)\s+spot\b/i.test(text)
  const hasExplicitActionPhrase = /\b(?:click|visit|come in)\s+(?:here|below|our|us|the)\b|\b(?:send|share)\s+(?:your|us|the|a|an)\b|\breply with\b|\bmessage us\b|\bconfirm\s+(?:your|the|a|an)\b/i.test(text)
  const hasClearNextAction = hasBookingCta || hasExplicitActionPhrase
  const questionWords = new Set(question.match(/[a-z0-9]+/g) || [])
  const genericReplyWords = new Set(['a', 'an', 'and', 'can', 'do', 'does', 'for', 'good', 'have', 'help', 'i', 'it', 'of', 'offer', 'our', 'provide', 'sure', 'the', 'to', 'we', 'will', 'with', 'yes', 'yeah', 'yep'])
  const subjectStopWords = new Set(['a', 'an', 'and', 'are', 'can', 'could', 'do', 'does', 'for', 'have', 'how', 'i', 'is', 'it', 'me', 'of', 'offer', 'on', 'or', 'please', 'provide', 'the', 'this', 'to', 'we', 'what', 'when', 'where', 'which', 'who', 'with', 'would', 'you', 'your'])
  const subjectTerms = [...questionWords].filter(word => word.length > 2 && !subjectStopWords.has(word))
  const replyMentionsQuestionSubject = subjectTerms.some(term => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
  const replyEvidenceWords = (text.match(/[a-z0-9]+/gi) || []).map(word => word.toLowerCase()).filter(word =>
    !questionWords.has(word) && !genericReplyWords.has(word) && !subjectStopWords.has(word)
  )
  const replyHasSpecificContent = /[$€£฿\d]/.test(text) || /\b(?:days?|hours?|weeks?|months?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|weekend|included|fee|fees|rate|rates|price|prices|cost|costs|refund|refundable|cancel|cancellation|table|tables|seat|seats|guest|guests|people|package|service|catering|address|email|phone)\b/i.test(replyEvidenceWords.join(' '))
  const actionSeekingQuestion = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|call|contact|message|next step|how do i|how can i)\b/i.test(question)
  const asksCancellation = /\b(cancel|cancellation|refunds?|reschedul|change|modify)\b/i.test(question)
  const asksCancellationPolicy = /\b(policy|terms|rules)\b/i.test(question)
  const asksBooking = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|availab|slot)\b/i.test(question)
  const asksContact = /\b(contact|reach|email|phone|number)\b/i.test(question)
  const replyAddressesCancellation = /\b(cancel|cancellation|refunds?|reschedul|change|modify)\b/i.test(lower)
  const replyAddressesBooking = /\b(book|booking|schedule|reserve|reservation|appointment|calendar|availab|slot)\b/i.test(lower)
  const replyAddressesContact = /\b(?:message us|call us|email us|send us a message|reach us|contact us)\b/i.test(lower)
  const actionIsRelevant = asksCancellation ? replyAddressesCancellation : asksBooking ? replyAddressesBooking : asksContact && replyAddressesContact
  const cancellationTarget = /\b(cancel|cancellation|refunds?|reschedul|changes?|modify|appointment|booking|reservation)\b/i
  const hasCancellationProcedure = /\b(call|contact|email|message|write|submit|request)\b/i.test(lower) && cancellationTarget.test(lower)
  const hasCancellationDetail =
    /\b(full|partial|no|non[- ]?refundable|refundable)\s+refunds?\b/i.test(lower) ||
    /\b(?:fee|charge|deposit|credit|eligible)\b.{0,80}\b(?:refunds?|cancellations?|cancel|reschedul|changes?)\b/i.test(lower) ||
    /\b(?:refunds?|cancellations?|cancel|reschedul|changes?)\b.{0,80}\b(?:fee|charge|deposit|credit|eligible)\b/i.test(lower) ||
    /\b(?:within|before|after)\s+\d+\s+(?:days?|hours?|weeks?)\b/i.test(lower) ||
    /\b(?:we|our policy|the business)\s+(?:offer|provide|give)\s+(?:full|partial|no)\s+refunds?\b/i.test(lower) ||
    /\bfree\s+(cancellations?|changes?|reschedulings?)\b/i.test(lower)

  const answerChecks = []
  const questionFacets = []
  let cancellationAnswerCheck = null
  if (/availab|open|slot|when|this week|today|tomorrow/.test(question)) {
    questionFacets.push('availability')
    answerChecks.push(/\b(available|availability|open|closed|booked|slot|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i)
  }
  if (/cost|price|how much|rate|fee/.test(question)) {
    questionFacets.push('pricing')
    const hasNumericPricing = /(?:[$€£฿]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|thb|dollars?|baht|per person|per night|each)\b)/i.test(text)
    const hasPricingTerms = /\b(?:free|complimentary|included|no charge)\b/i.test(text)
    const hasPricingExplanation = /\b(?:price|prices|cost|costs|rate|rates|fee|fees|pricing)\b.{0,40}\b(?:range|start|starts|included)\b/i.test(text) ||
      /\b(?:price|prices|cost|costs|rate|rates|fee|fees|pricing)\b.{0,40}\b(?:varies|depends)\s+(?:by|on)\s+(?:the\s+)?(?:person|people|guest|guests|group|groups|date|day|time|duration|service|package|size|location|season|option|number)\b/i.test(text)
    answerChecks.push(() => hasNumericPricing || hasPricingTerms || hasPricingExplanation)
  }
  if (/do you|can you|offer|provide|have you/.test(question)) {
    answerChecks.push(() => /\b(yes|no|we do|we don't|we can|we cannot|we offer|we provide)\b/i.test(text) && replyHasSpecificContent && replyMentionsQuestionSubject)
  }
  if (asksCancellation) {
    questionFacets.push('cancellation')
    cancellationAnswerCheck = () => replyAddressesCancellation && (hasCancellationDetail || (!asksCancellationPolicy && hasCancellationProcedure))
    answerChecks.push(cancellationAnswerCheck)
  }
  if (asksContact) {
    const hasEmailAddress = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    const hasPhoneNumber = (text.match(/\d/g) || []).length >= 7
    answerChecks.push(() => hasEmailAddress || hasPhoneNumber)
  }
  const answersQuestion = answerChecks.length > 0 &&
    !(isGenericConfirmation && asksCancellation) &&
    !(questionFacets.length > 1 && isGenericConfirmation) &&
    (asksCancellation
      ? cancellationAnswerCheck(text)
      : answerChecks.some(check => typeof check === 'function' ? check(text) : check.test(text)))

  const isUseful = Boolean(text) && (
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

function calculateNumericFacebookAuditScore({
  customerQuestion = '',
  score,
  observations = {},
  replies = []
} = {}) {
  if (!score?.grade) return null

  if (score.grade === 'F') {
    const total = score.behaviorBand === 'C' ? 20 : score.behaviorBand === 'D' ? 10 : 0
    return {
      total,
      usefulAnswer: 0,
      responseSpeed: 0,
      qualificationQuestion: 0,
      clearNextAction: 0,
      responseSeconds: null,
      aGradeGapSeconds: null,
      method: 'holistic-v1'
    }
  }

  const derived = (Array.isArray(replies) ? replies : []).map(reply =>
    classifyFacebookReply(reply?.text, { customerQuestion })
  )
  const hasQualificationQuestion = Boolean(observations.qualificationQuestion) ||
    derived.some(item => item.hasQualificationQuestion)
  const hasClearNextAction = Boolean(observations.bookingCta || observations.clearNextAction) ||
    derived.some(item => item.hasBookingCta || item.hasClearNextAction)
  const responseSeconds = Number.isFinite(Number(score.responseSeconds))
    ? Math.max(0, Number(score.responseSeconds))
    : null
  const responseSpeed = responseSeconds === null
    ? 0
    : Math.max(0, Math.min(20, Math.round(20 * (120 - Math.min(120, responseSeconds)) / 120)))
  const usefulAnswer = 70
  const qualificationQuestion = hasQualificationQuestion ? 5 : 0
  const clearNextAction = hasClearNextAction ? 5 : 0

  return {
    total: usefulAnswer + responseSpeed + qualificationQuestion + clearNextAction,
    usefulAnswer,
    responseSpeed,
    qualificationQuestion,
    clearNextAction,
    responseSeconds,
    aGradeGapSeconds: responseSeconds === null ? null : Math.max(0, responseSeconds - 60),
    method: 'holistic-v1'
  }
}

module.exports = {
  TWO_MINUTES_MS,
  buildAuditRequest,
  calculateNumericFacebookAuditScore,
  classifyFacebookReply,
  containsAbusiveCustomerLanguage,
  createReportToken,
  hashReportToken,
  normalizeFacebookPageUrl,
  scoreFacebookAudit,
  verifyReportToken
}
