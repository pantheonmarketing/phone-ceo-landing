const crypto = require('node:crypto')
const net = require('node:net')
const {
  containsAbusiveCustomerLanguage,
  createReportToken,
  hashReportToken,
  verifyReportToken
} = require('./facebook-audit')

const WEBSITE_RESPONSE_MS = 60000
const CUSTOMER_QUESTION_LANGUAGE_ERROR = 'Please rewrite the customer question without abusive or offensive language'

function clean(value, max) {
  return String(value || '').trim().slice(0, max)
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
}

function isPrivateHostname(value) {
  const hostname = String(value || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true
  if (net.isIP(hostname)) return net.isIPv4(hostname) ? isPrivateIpv4(hostname) : true
  return false
}

function normalizeWebsiteUrl(value) {
  const raw = clean(value, 1000)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter a valid public website URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new Error('Enter a valid public website URL')
  }
  url.hash = ''
  url.search = ''
  return url.toString()
}

function websiteAuditId() {
  return `WBA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

function buildWebsiteAuditRequest(input, now = new Date()) {
  if (!input || input.authorized !== true) {
    throw new Error('You must confirm authorization before we can run this test')
  }
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl)
  const businessName = clean(input.businessName, 160) || 'This business'
  const customerQuestion = clean(input.customerQuestion, 500) || 'Hi, I am interested in your service. Can you tell me the price and availability?'
  if (containsAbusiveCustomerLanguage(customerQuestion)) throw new Error(CUSTOMER_QUESTION_LANGUAGE_ERROR)
  const auditId = websiteAuditId()
  const requestedAt = now.toISOString()
  return {
    auditId,
    websiteUrl,
    businessName,
    customerQuestion,
    testMessage: customerQuestion,
    disclosureMessage: `Thank you for replying. This was an authorized customer-response audit for ${businessName}. Audit ID: ${auditId}.`,
    requestedAt,
    deadlineAt: null
  }
}

function gradeFor(total) {
  if (total >= 85) return 'A'
  if (total >= 70) return 'B'
  if (total >= 50) return 'C'
  if (total >= 30) return 'D'
  return 'F'
}

function labelFor(grade) {
  if (grade === 'A') return 'A ready buyer can get useful help immediately'
  if (grade === 'B') return 'The buyer journey works, with room to improve'
  if (grade === 'C') return 'Buyers can reach you, but instant help is inconsistent'
  if (grade === 'D') return 'Buyers face avoidable friction'
  return 'A ready buyer is likely to leave without an answer'
}

function calculateWebsiteAuditScore(observations = {}) {
  if (observations.pageReachable !== true) return null
  const contactClicks = Number.isFinite(observations.contactClicks) ? Math.max(0, observations.contactClicks) : null
  const reachability = 20
  const buyerFriction = contactClicks === 0 ? 15 : contactClicks === 1 ? 12 : contactClicks === 2 ? 8 : contactClicks >= 3 ? 4 : 0
  const responseSeconds = Number.isFinite(observations.responseSeconds) ? Math.max(0, Math.ceil(observations.responseSeconds)) : null
  const timelyResponse = observations.messageSent === true && responseSeconds !== null && responseSeconds <= WEBSITE_RESPONSE_MS / 1000
  const instantHelp = (observations.chatAvailable ? 10 : 0) + (timelyResponse ? 15 : 0)
  const answerQuality = timelyResponse && observations.usefulReply ? 25 : 0
  const qualificationNextAction = (observations.qualificationQuestion ? 8 : 0) +
    (observations.clearNextAction || observations.bookingAvailable ? 7 : 0)
  const total = Math.min(100, reachability + buyerFriction + instantHelp + answerQuality + qualificationNextAction)
  const grade = gradeFor(total)
  return {
    total,
    grade,
    label: labelFor(grade),
    reachability,
    buyerFriction,
    instantHelp,
    answerQuality,
    qualificationNextAction,
    responseSeconds,
    method: 'website-buyer-journey-v1'
  }
}

module.exports = {
  WEBSITE_RESPONSE_MS,
  buildWebsiteAuditRequest,
  calculateWebsiteAuditScore,
  createReportToken,
  hashReportToken,
  isPrivateHostname,
  normalizeWebsiteUrl,
  verifyReportToken,
  websiteAuditId
}
