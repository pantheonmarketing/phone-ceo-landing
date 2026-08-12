const { EventEmitter } = require('node:events')
const { transitionAudit } = require('./facebook-audit-state')
const { VersionConflictError } = require('./facebook-audit-store')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizeBlobEtag(value) {
  return String(value || '').replace(/^W\//, '')
}

function isBlobConflict(error) {
  const status = Number(error?.status || error?.statusCode)
  return status === 409 || status === 412 || /precondition|already exists|conflict/i.test(String(error?.name || error?.message || ''))
}

class VercelBlobAuditStore extends EventEmitter {
  constructor({ token, prefix = 'facebook-audits', blob } = {}) {
    super()
    this.token = token
    this.prefix = String(prefix).replace(/^\/+|\/+$/g, '')
    this.blob = blob
  }

  _options(extra = {}) {
    return { token: this.token, ...extra }
  }

  _recordPath(auditId) {
    if (!/^FBA-[A-F0-9]{8}$/i.test(String(auditId))) throw new Error('Invalid audit ID')
    return `${this.prefix}/records/${String(auditId).toUpperCase()}.json`
  }

  _rateLimitPath() {
    return `${this.prefix}/rate-limit/public-posts.json`
  }

  async _read(auditId) {
    const { get } = this.blob || require('@vercel/blob')
    const result = await get(this._recordPath(auditId), this._options({ access: 'private', useCache: false }))
    if (!result || result.statusCode !== 200 || !result.stream) return null
    const text = await new Response(result.stream).text()
    return { record: JSON.parse(text), etag: normalizeBlobEtag(result.blob.etag) }
  }

  async create(record) {
    const { put } = require('@vercel/blob')
    await put(this._recordPath(record.auditId), JSON.stringify(record), this._options({
      access: 'private',
      contentType: 'application/json',
      cacheControlMaxAge: 60,
      allowOverwrite: false
    }))
    this.emit('changed', clone(record))
    return clone(record)
  }

  async get(auditId) {
    const result = await this._read(auditId)
    return clone(result?.record || null)
  }

  async consumeRateLimit({ limit = 5, windowMs = 600000 } = {}) {
    const { get, put } = this.blob || require('@vercel/blob')
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5
    const safeWindowMs = Number.isFinite(windowMs) ? Math.max(1000, Math.floor(windowMs)) : 600000
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let current = null
      try {
        const result = await get(this._rateLimitPath(), this._options({ access: 'private', useCache: false }))
        if (result && result.statusCode !== 404 && result.stream) {
          current = {
            record: JSON.parse(await new Response(result.stream).text()),
            etag: normalizeBlobEtag(result.blob.etag)
          }
        }
      } catch (error) {
        const status = Number(error?.status || error?.statusCode)
        if (status !== 404 && !/not.?found/i.test(String(error?.name || error?.message || ''))) throw error
      }

      const now = Date.now()
      const active = current && now - Number(current.record.startedAt) < safeWindowMs
      if (active && Number(current.record.count) >= safeLimit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((safeWindowMs - (now - Number(current.record.startedAt))) / 1000))
        }
      }
      const next = active
        ? { startedAt: Number(current.record.startedAt), count: Number(current.record.count) + 1 }
        : { startedAt: now, count: 1 }
      try {
        await put(this._rateLimitPath(), JSON.stringify(next), this._options({
          access: 'private',
          contentType: 'application/json',
          allowOverwrite: Boolean(current),
          ...(current ? { ifMatch: current.etag } : {})
        }))
        return { allowed: true, remaining: Math.max(0, safeLimit - next.count) }
      } catch (error) {
        if (!isBlobConflict(error)) throw error
      }
    }
    throw new Error('The shared audit rate limiter could not be updated')
  }

  async list({ statuses, limit = 100 } = {}) {
    const { list } = this.blob || require('@vercel/blob')
    const allowed = statuses ? new Set(statuses) : null
    const records = []
    let cursor
    do {
      const page = await list(this._options({ prefix: `${this.prefix}/records/`, limit: Math.min(1000, limit * 3), cursor }))
      for (const pathname of page.blobs.map(blob => blob.pathname)) {
        const match = pathname.match(/(FBA-[A-F0-9]{8})\.json$/i)
        if (!match) continue
        const record = await this.get(match[1])
        if (record && (!allowed || allowed.has(record.status))) records.push(record)
        if (records.length >= limit) break
      }
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor && records.length < limit)
    return records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map(clone)
  }

  async update(auditId, updater, expectedVersion) {
    const { BlobPreconditionFailedError, put } = require('@vercel/blob')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await this._read(auditId)
      if (!current) throw new Error(`Audit ${auditId} was not found`)
      if (expectedVersion != null && current.record.version !== expectedVersion) throw new VersionConflictError()
      const next = await updater(clone(current.record))
      if (!next || next.auditId !== current.record.auditId) throw new Error('Audit updater returned an invalid record')
      next.version = current.record.version + 1
      try {
        await put(this._recordPath(auditId), JSON.stringify(next), this._options({
          access: 'private',
          contentType: 'application/json',
          cacheControlMaxAge: 60,
          allowOverwrite: true,
          ifMatch: current.etag
        }))
        this.emit('changed', clone(next))
        return clone(next)
      } catch (error) {
        if (!(error instanceof BlobPreconditionFailedError)) throw error
        if (expectedVersion != null || attempt === 5) throw new VersionConflictError()
      }
    }
    throw new VersionConflictError()
  }

  async claimNext(workerId, now = new Date()) {
    const queued = (await this.list({ statuses: ['queued'], limit: 100 }))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    for (const record of queued) {
      try {
        return await this.update(record.auditId, current => {
          if (current.status !== 'queued') throw new VersionConflictError()
          return transitionAudit(current, 'starting', { workerId, message: 'Worker claimed queued audit' }, now)
        }, record.version)
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error
      }
    }
    return null
  }

  async putEvidence(auditId, { buffer, contentType = 'image/png', label = 'evidence' }) {
    const { put } = require('@vercel/blob')
    const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'evidence'
    const extension = contentType === 'image/jpeg' ? 'jpg' : 'png'
    const pathname = `${this.prefix}/evidence/${String(auditId).toUpperCase()}/${Date.now()}-${safeLabel}.${extension}`
    const result = await put(pathname, buffer, this._options({ access: 'private', contentType, allowOverwrite: false }))
    return result.pathname
  }

  async getEvidence(reference) {
    const { get } = require('@vercel/blob')
    if (!String(reference || '').startsWith(`${this.prefix}/evidence/`)) throw new Error('Invalid evidence reference')
    const result = await get(reference, this._options({ access: 'private', useCache: false }))
    if (!result || result.statusCode !== 200 || !result.stream) return null
    return Buffer.from(await new Response(result.stream).arrayBuffer())
  }
}

module.exports = { VercelBlobAuditStore, normalizeBlobEtag }
