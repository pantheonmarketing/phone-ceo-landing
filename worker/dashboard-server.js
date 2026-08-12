const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { URL } = require('node:url')
const { recordAuditEvent } = require('../lib/facebook-audit-state')

const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html')

function sanitizeAudit(record) {
  if (!record) return null
  const { reportTokenHash, ...safe } = JSON.parse(JSON.stringify(record))
  return safe
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65536) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function isLoopbackHost(value) {
  const raw = String(value || '').toLowerCase()
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase().replace(/^::ffff:/, '')
  return address === '::1' || address === '127.0.0.1' || address === 'localhost'
}

function localRequest(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const origin = String(req.headers.origin || '').trim()
  const localHost = isLoopbackHost(host)
  const localSocket = !req.socket?.remoteAddress || isLoopbackAddress(req.socket.remoteAddress)
  if (!localHost || !localSocket) return false
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHost(parsed.hostname) &&
      (!parsed.port || !host.includes(':') || parsed.port === host.split(':').at(-1))
  } catch {
    return false
  }
}

function createDashboardServer({ store, controller, host = '127.0.0.1', port = 4317 }) {
  if (!isLoopbackHost(host)) throw new Error('Dashboard host must be loopback-only')
  const streams = new Set()
  let dashboardHtml

  function publish(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const response of streams) response.write(payload)
  }

  const onStoreChanged = audit => publish('audit', sanitizeAudit(audit))
  const onControllerChanged = status => publish('worker', status)
  store.on?.('changed', onStoreChanged)
  controller.on?.('changed', onControllerChanged)

  const server = http.createServer(async (req, res) => {
    try {
      if (!localRequest(req)) return sendJson(res, 403, { error: 'Local dashboard access only' })
      const requestUrl = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`)

      if (req.method === 'GET' && requestUrl.pathname === '/') {
        dashboardHtml ||= await fs.readFile(DASHBOARD_PATH, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
        })
        return res.end(dashboardHtml)
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/audits') {
        const audits = await store.list({ limit: 250 })
        return sendJson(res, 200, { audits: audits.map(sanitizeAudit) })
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/worker') {
        return sendJson(res, 200, { worker: controller.getStatus() })
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.write(`event: worker\ndata: ${JSON.stringify(controller.getStatus())}\n\n`)
        streams.add(res)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)
        req.on('close', () => {
          clearInterval(heartbeat)
          streams.delete(res)
        })
        return
      }

      if (req.method === 'GET' && requestUrl.pathname === '/api/evidence') {
        const auditId = String(requestUrl.searchParams.get('auditId') || '').toUpperCase()
        const evidenceId = String(requestUrl.searchParams.get('evidenceId') || '')
        const audit = await store.get(auditId)
        const evidence = audit?.evidence?.find(item => item.evidenceId === evidenceId)
        if (!evidence || !store.getEvidence) return sendJson(res, 404, { error: 'Evidence not found' })
        const buffer = await store.getEvidence(evidence.reference)
        if (!buffer) return sendJson(res, 404, { error: 'Evidence not found' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        return res.end(buffer)
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/control') {
        const body = await readJson(req)
        if (body.action === 'pause') controller.pause()
        else if (body.action === 'resume') controller.resume()
        else return sendJson(res, 400, { error: 'Unknown control action' })
        return sendJson(res, 200, { worker: controller.getStatus() })
      }

      const classifyMatch = req.method === 'POST' && requestUrl.pathname.match(/^\/api\/audits\/(FBA-[A-F0-9]{8})\/classify$/i)
      if (classifyMatch) {
        const body = await readJson(req)
        const replyId = String(body.replyId || '')
        if (typeof body.isUseful !== 'boolean') throw new Error('A manual usefulness decision is required')
        const updated = await store.update(classifyMatch[1].toUpperCase(), current => {
          if (current.status !== 'waiting') throw new Error('Only an active waiting audit can be manually classified')
          const reply = current.replies.find(item => item.replyId === replyId)
          if (!reply) throw new Error('Reply not found')
          const classification = { ...reply.classification, isUseful: body.isUseful, manuallyReviewed: true }
          for (const field of ['isAutoAcknowledgement', 'hasQualificationQuestion', 'hasBookingCta', 'hasClearNextAction']) {
            if (typeof body[field] === 'boolean') classification[field] = body[field]
          }
          reply.classification = classification
          if (classification.isUseful) current.usefulReplyAt ||= reply.receivedAt
          current.observations.autoAcknowledged ||= Boolean(classification.isAutoAcknowledgement)
          current.observations.qualificationQuestion ||= Boolean(classification.hasQualificationQuestion)
          current.observations.bookingCta ||= Boolean(classification.hasBookingCta)
          current.observations.clearNextAction ||= Boolean(classification.hasClearNextAction)
          return recordAuditEvent(current, 'manual_classification', {
            status: current.status,
            replyId,
            classification: reply.classification,
            message: 'Operator reviewed reply classification'
          })
        })
        return sendJson(res, 200, { audit: sanitizeAudit(updated) })
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      const safeMessages = new Set([
        'Request body is too large',
        'Unknown control action',
        'Only an active waiting audit can be manually classified',
        'Reply not found',
        'A manual usefulness decision is required',
        'Evidence not found'
      ])
      sendJson(res, 400, { error: safeMessages.has(error.message) ? error.message : 'Dashboard request failed' })
    }
  })

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      const address = server.address()
      return { host, port: address.port, url: `http://${host}:${address.port}/` }
    },
    async stop() {
      store.off?.('changed', onStoreChanged)
      controller.off?.('changed', onControllerChanged)
      for (const stream of streams) stream.end()
      streams.clear()
      if (!server.listening) return
      await new Promise(resolve => server.close(resolve))
    }
  }
}

module.exports = { createDashboardServer, sanitizeAudit }
