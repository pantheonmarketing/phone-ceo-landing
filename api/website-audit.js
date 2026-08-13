const {
  buildWebsiteAuditRequest,
  createReportToken,
  hashReportToken
} = require('../lib/website-audit')
const {
  createWebsiteAuditRecord,
  publicWebsiteAuditView,
  recordWebsiteEvent
} = require('../lib/website-audit-state')
const { createAuditStoreFromEnv } = require('../lib/facebook-audit-store')
const { safeTelegramErrorCode, sendTelegram } = require('../lib/telegram-notifier')
const { createRateLimiter } = require('./facebook-audit')

const MAX_REQUEST_BYTES = 16 * 1024
const DEFAULT_POST_LIMIT = 5
const DEFAULT_POST_WINDOW_MS = 10 * 60 * 1000
const defaultPostRateLimiter = createRateLimiter()

const json = (res, status, body) => {
  res
    .status(status)
    .setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Audit-Report-Token')
    .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .setHeader('Vary', 'Origin')
    .setHeader('Cache-Control', 'no-store')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .json(body)
}

function requestOrigin(req) {
  const origin = String(req.headers?.origin || '').trim()
  if (!origin) return ''
  const configured = String(process.env.AUDIT_ALLOWED_ORIGIN || process.env.FACEBOOK_AUDIT_ALLOWED_ORIGIN || '').trim().replace(/\/$/, '')
  if (configured) return origin.replace(/\/$/, '') === configured ? configured : null
  const host = String(req.headers?.host || '').trim().toLowerCase()
  return origin === `https://${host}` || origin === `http://${host}` ? origin : null
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'unknown')
}

function storeRateLimiter(store) {
  if (typeof store.consumeRateLimit !== 'function') return defaultPostRateLimiter
  return {
    check: key => store.consumeRateLimit({ key, limit: DEFAULT_POST_LIMIT, windowMs: DEFAULT_POST_WINDOW_MS })
  }
}

function requestTooLarge(body) {
  try {
    return Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > MAX_REQUEST_BYTES
  } catch {
    return true
  }
}

async function notifyTelegram(audit) {
  await sendTelegram([
    'NEW WEBSITE BUYER JOURNEY AUDIT',
    '',
    `Audit: ${audit.auditId}`,
    `Business: ${audit.businessName}`,
    `Website: ${audit.websiteUrl}`,
    `Buyer question: ${audit.customerQuestion}`,
    'Contact forms will be inspected but never submitted.',
    'At most one live-chat question may be sent if a usable chat is found.',
    '',
    `Requested: ${audit.requestedAt}`
  ].join('\n'))
}

async function notifyFinalTelegram(audit) {
  const result = audit.status === 'error'
    ? `ERROR (${audit.error?.code || 'unknown'}) - ${audit.error?.message || 'Audit could not be completed'}`
    : `${audit.score?.total ?? 'UNSCORED'}/100 (${audit.score?.grade || 'unscored'}) - ${audit.score?.label || audit.status}`
  await sendTelegram([
    'WEBSITE AUDIT COMPLETE',
    '',
    `Audit: ${audit.auditId}`,
    `Business: ${audit.businessName}`,
    `Result: ${result}`,
    `Question sent: ${audit.sentAt || 'no usable live chat found'}`,
    `Completed: ${audit.completedAt || audit.updatedAt}`
  ].join('\n'))
}

let defaultStore
function getDefaultStore() {
  defaultStore ||= createAuditStoreFromEnv()
  return defaultStore
}

function single(value) {
  return Array.isArray(value) ? value[0] : value
}

function createHandler({ store, notifyTelegram: notify = notifyTelegram, rateLimiter } = {}) {
  return async function handler(req, res) {
    const origin = requestOrigin(req)
    if (origin === null) return json(res, 403, { error: 'Cross-origin audit requests are not allowed' })
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
    if (req.method === 'OPTIONS') return json(res, 204, {})
    const auditStore = store || getDefaultStore()

    if (req.method === 'GET') {
      const auditId = String(single(req.query?.auditId) || '').trim().toUpperCase()
      const token = String(single(req.query?.token) || req.headers?.['x-audit-report-token'] || '').trim()
      if (!/^WBA-[A-F0-9]{8}$/.test(auditId) || !token) return json(res, 404, { error: 'Audit not found' })
      try {
        const view = publicWebsiteAuditView(await auditStore.get(auditId), token)
        return view ? json(res, 200, view) : json(res, 404, { error: 'Audit not found' })
      } catch (error) {
        console.error('Website audit report lookup failed', { auditId, code: error.code || error.name })
        return json(res, 503, { error: 'The audit report is temporarily unavailable.' })
      }
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
    let decision
    try {
      decision = await Promise.resolve((rateLimiter || storeRateLimiter(auditStore)).check(clientKey(req)))
    } catch (error) {
      console.error('Website audit rate limiter failed', { code: error.code || error.name })
      return json(res, 503, { error: 'The audit service is temporarily unavailable.' })
    }
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds))
      return json(res, 429, { error: 'Too many audit requests. Please try again later.' })
    }
    if (requestTooLarge(req.body)) return json(res, 413, { error: 'Audit request is too large' })

    let request
    try {
      request = buildWebsiteAuditRequest(req.body || {})
    } catch (error) {
      return json(res, 400, { error: error.message })
    }

    const reportToken = createReportToken()
    try {
      await auditStore.create(createWebsiteAuditRecord(request, hashReportToken(reportToken)))
    } catch (error) {
      console.error('Website audit durable queue failed', { auditId: request.auditId, code: error.code || error.name })
      return json(res, 503, { error: 'We could not safely queue the audit. Please try again.' })
    }

    let notificationWarning = null
    try {
      await notify(request)
    } catch (error) {
      const notificationCode = safeTelegramErrorCode(error)
      notificationWarning = 'The audit was queued, but the private notification could not be delivered.'
      console.error('Website audit notification failed', { auditId: request.auditId, code: notificationCode })
      await auditStore.update(request.auditId, current => recordWebsiteEvent(current, 'notification_failed', {
        status: current.status,
        code: notificationCode,
        message: 'Initial private notification failed'
      })).catch(() => {})
    }

    const reportUrl = `/audit-result.html#websiteAuditId=${encodeURIComponent(request.auditId)}&websiteToken=${encodeURIComponent(reportToken)}`
    return json(res, 200, {
      success: true,
      auditId: request.auditId,
      reportToken,
      reportUrl,
      deadlineAt: null,
      status: 'queued',
      notificationWarning
    })
  }
}

const handler = createHandler()
module.exports = handler
module.exports.createHandler = createHandler
module.exports.notifyFinalTelegram = notifyFinalTelegram
module.exports.notifyTelegram = notifyTelegram
