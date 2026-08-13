const {
  buildAuditRequest,
  createReportToken,
  hashReportToken
} = require('../lib/facebook-audit')
const {
  createAuditRecord,
  publicAuditView,
  recordAuditEvent
} = require('../lib/facebook-audit-state')
const { createAuditStoreFromEnv } = require('../lib/facebook-audit-store')

const MAX_REQUEST_BYTES = 16 * 1024
const DEFAULT_POST_LIMIT = 5
const DEFAULT_POST_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_MAX_RATE_LIMIT_KEYS = 10000

function createRateLimiter({
  limit = DEFAULT_POST_LIMIT,
  windowMs = DEFAULT_POST_WINDOW_MS,
  maxKeys = DEFAULT_MAX_RATE_LIMIT_KEYS,
  now = () => Date.now()
} = {}) {
  const buckets = new Map()
  const capacity = Number.isFinite(maxKeys) ? Math.max(1, Math.floor(maxKeys)) : DEFAULT_MAX_RATE_LIMIT_KEYS
  return {
    check(key) {
      const current = now()
      for (const [storedKey, bucket] of buckets) {
        if (current - bucket.startedAt >= windowMs) buckets.delete(storedKey)
      }
      const bucketKey = String(key || 'unknown').slice(0, 200)
      const previous = buckets.get(bucketKey)
      if (!previous) {
        while (buckets.size >= capacity) buckets.delete(buckets.keys().next().value)
        buckets.set(bucketKey, { startedAt: current, count: 1 })
        return { allowed: true, remaining: Math.max(0, limit - 1) }
      }
      if (previous.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (current - previous.startedAt)) / 1000))
        }
      }
      previous.count += 1
      return { allowed: true, remaining: Math.max(0, limit - previous.count) }
    },
    size: () => buckets.size
  }
}

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
  const configured = String(process.env.FACEBOOK_AUDIT_ALLOWED_ORIGIN || '').trim().replace(/\/$/, '')
  if (configured) return origin.replace(/\/$/, '') === configured ? configured : null
  const host = String(req.headers?.host || '').trim().toLowerCase()
  return origin === `https://${host}` || origin === `http://${host}` ? origin : null
}

function requestOriginAllowed(req) {
  return requestOrigin(req) !== null
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'unknown')
}

function storeRateLimiter(store) {
  if (typeof store.consumeRateLimit !== 'function') return defaultPostRateLimiter
  return {
    check: key => store.consumeRateLimit({
      key,
      limit: DEFAULT_POST_LIMIT,
      windowMs: DEFAULT_POST_WINDOW_MS
    })
  }
}

function requestTooLarge(body) {
  try {
    return Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > MAX_REQUEST_BYTES
  } catch {
    return true
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) throw new Error('Audit notifications are not configured')
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  })
  if (!response.ok) throw new Error('Telegram notification failed')
}

async function notifyTelegram(audit) {
  const text = [
    'NEW FACEBOOK RESPONSE AUDIT',
    '',
    `Audit: ${audit.auditId}`,
    `Business: ${audit.businessName}`,
    `Facebook: ${audit.pageUrl}`,
    `Buyer question: ${audit.customerQuestion}`,
    'The two-minute deadline starts only after the browser confirms the message was sent.',
    '',
    `Requested: ${audit.requestedAt}`
  ].join('\n')
  await sendTelegram(text)
}

async function notifyFinalTelegram(audit) {
  const result = audit.status === 'error'
    ? `ERROR (${audit.error?.code || 'unknown'}) - ${audit.error?.message || 'Audit could not be completed'}`
    : `${audit.score?.grade || 'UNSCORED'} - ${audit.score?.label || audit.status}`
  const text = [
    'FACEBOOK AUDIT COMPLETE',
    '',
    `Audit: ${audit.auditId}`,
    `Business: ${audit.businessName}`,
    `Result: ${result}`,
    `Sent: ${audit.sentAt || 'not sent'}`,
    `Completed: ${audit.completedAt || audit.updatedAt}`
  ].join('\n')
  await sendTelegram(text)
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
    if (req.method === 'POST') {
      let decision
      try {
        decision = await Promise.resolve((rateLimiter || storeRateLimiter(auditStore)).check(clientKey(req)))
      } catch (error) {
        console.error('Facebook audit rate limiter failed', { code: error.code || error.name })
        return json(res, 503, { error: 'The audit service is temporarily unavailable.' })
      }
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds))
        return json(res, 429, { error: 'Too many audit requests. Please try again later.' })
      }
      if (requestTooLarge(req.body)) return json(res, 413, { error: 'Audit request is too large' })
    }

    if (req.method === 'GET') {
      const auditId = String(single(req.query?.auditId) || '').trim()
      const token = String(single(req.query?.token) || req.headers?.['x-audit-report-token'] || '').trim()
      if (!/^FBA-[A-F0-9]{8}$/i.test(auditId) || !token) return json(res, 404, { error: 'Audit not found' })
      try {
        const audit = await auditStore.get(auditId.toUpperCase())
        const view = publicAuditView(audit, token)
        if (!view) return json(res, 404, { error: 'Audit not found' })
        return json(res, 200, view)
      } catch (error) {
      console.error('Facebook audit report lookup failed', { auditId, code: error.code || error.name })
        return json(res, 503, { error: 'The audit report is temporarily unavailable.' })
      }
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })

    let request
    try {
      request = buildAuditRequest(req.body || {})
    } catch (error) {
      return json(res, 400, { error: error.message })
    }

    const reportToken = createReportToken()
    const record = createAuditRecord(request, hashReportToken(reportToken))
    try {
      await auditStore.create(record)
    } catch (error) {
      console.error('Facebook audit durable queue failed', { auditId: request.auditId, code: error.code || error.name })
      return json(res, 503, { error: 'We could not safely queue the audit. Please try again.' })
    }

    let notificationWarning = null
    try {
      await notify(request)
    } catch (error) {
      notificationWarning = 'The audit was queued, but the private notification could not be delivered.'
      console.error('Facebook audit notification failed', { auditId: request.auditId, code: error.code || error.name })
      try {
        await auditStore.update(request.auditId, current => recordAuditEvent(current, 'notification_failed', {
          status: current.status,
          message: 'Initial private notification failed'
        }))
      } catch (updateError) {
        console.error('Facebook audit notification failure event could not be stored', { auditId: request.auditId, code: updateError.code || updateError.name })
      }
    }

    const reportUrl = `/facebook-audit-result.html#auditId=${encodeURIComponent(request.auditId)}&token=${encodeURIComponent(reportToken)}`
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
module.exports.createRateLimiter = createRateLimiter
module.exports.requestOriginAllowed = requestOriginAllowed
