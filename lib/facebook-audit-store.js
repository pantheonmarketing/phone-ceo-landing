const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const path = require('node:path')
const { transitionAudit } = require('./facebook-audit-state')

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

class VersionConflictError extends Error {
  constructor(message = 'Audit version conflict') {
    super(message)
    this.name = 'VersionConflictError'
    this.code = 'version_conflict'
  }
}

class MemoryAuditStore extends EventEmitter {
  constructor() {
    super()
    this.records = new Map()
    this.lock = Promise.resolve()
  }

  _locked(operation) {
    const running = this.lock.then(operation, operation)
    this.lock = running.catch(() => {})
    return running
  }

  async create(record) {
    return this._locked(async () => {
      if (this.records.has(record.auditId)) throw new Error(`Audit ${record.auditId} already exists`)
      const saved = clone(record)
      this.records.set(saved.auditId, saved)
      this.emit('changed', clone(saved))
      return clone(saved)
    })
  }

  async get(auditId) {
    return clone(this.records.get(String(auditId)) || null)
  }

  async list({ statuses, limit = 100 } = {}) {
    const allowed = statuses ? new Set(statuses) : null
    return [...this.records.values()]
      .filter(record => !allowed || allowed.has(record.status))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
      .map(clone)
  }

  async update(auditId, updater, expectedVersion) {
    return this._locked(async () => {
      const current = this.records.get(String(auditId))
      if (!current) throw new Error(`Audit ${auditId} was not found`)
      if (expectedVersion != null && current.version !== expectedVersion) throw new VersionConflictError()
      const next = await updater(clone(current))
      if (!next || next.auditId !== current.auditId) throw new Error('Audit updater returned an invalid record')
      next.version = current.version + 1
      this.records.set(current.auditId, clone(next))
      this.emit('changed', clone(next))
      return clone(next)
    })
  }

  async claimNext(workerId, now = new Date()) {
    return this._locked(async () => {
      const queued = [...this.records.values()]
        .filter(record => record.status === 'queued')
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
      if (!queued) return null
      const claimed = transitionAudit(queued, 'starting', { workerId, message: 'Worker claimed queued audit' }, now)
      claimed.version = queued.version + 1
      this.records.set(claimed.auditId, clone(claimed))
      this.emit('changed', clone(claimed))
      return clone(claimed)
    })
  }
}

class FileAuditStore extends EventEmitter {
  constructor({ directory }) {
    super()
    if (!directory) throw new Error('FileAuditStore requires a data directory')
    this.directory = path.resolve(directory)
    this.recordsDirectory = path.join(this.directory, 'records')
    this.evidenceDirectory = path.join(this.directory, 'evidence')
    this.lock = Promise.resolve()
  }

  _locked(operation) {
    const running = this.lock.then(operation, operation)
    this.lock = running.catch(() => {})
    return running
  }

  _recordPath(auditId) {
    if (!/^FBA-[A-F0-9]{8}$/i.test(String(auditId))) throw new Error('Invalid audit ID')
    return path.join(this.recordsDirectory, `${String(auditId).toUpperCase()}.json`)
  }

  async _init() {
    await fs.mkdir(this.recordsDirectory, { recursive: true })
    await fs.mkdir(this.evidenceDirectory, { recursive: true })
  }

  async _getUnlocked(auditId) {
    try {
      return JSON.parse(await fs.readFile(this._recordPath(auditId), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async _listUnlocked({ statuses, limit = 100 } = {}) {
    await this._init()
    const allowed = statuses ? new Set(statuses) : null
    const names = (await fs.readdir(this.recordsDirectory)).filter(name => /^FBA-[A-F0-9]{8}\.json$/i.test(name))
    const records = (await Promise.all(names.map(name => this._getUnlocked(name.slice(0, -5))))).filter(Boolean)
    const sorted = records
      .filter(record => !allowed || allowed.has(record.status))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    return (limit == null ? sorted : sorted.slice(0, limit)).map(clone)
  }

  async _writeUnlocked(record, options = {}) {
    await this._init()
    await fs.writeFile(this._recordPath(record.auditId), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: options.exclusive ? 'wx' : 'w'
    })
  }

  async create(record) {
    return this._locked(async () => {
      const saved = clone(record)
      await this._writeUnlocked(saved, { exclusive: true })
      this.emit('changed', clone(saved))
      return clone(saved)
    })
  }

  async get(auditId) {
    return this._locked(async () => {
      await this._init()
      return clone(await this._getUnlocked(auditId))
    })
  }

  async list(options = {}) {
    return this._locked(async () => clone(await this._listUnlocked(options)))
  }

  async update(auditId, updater, expectedVersion) {
    return this._locked(async () => {
      const current = await this._getUnlocked(auditId)
      if (!current) throw new Error(`Audit ${auditId} was not found`)
      if (expectedVersion != null && current.version !== expectedVersion) throw new VersionConflictError()
      const next = await updater(clone(current))
      if (!next || next.auditId !== current.auditId) throw new Error('Audit updater returned an invalid record')
      next.version = current.version + 1
      await this._writeUnlocked(next)
      this.emit('changed', clone(next))
      return clone(next)
    })
  }

  async claimNext(workerId, now = new Date()) {
    return this._locked(async () => {
      const queued = (await this._listUnlocked({ statuses: ['queued'], limit: null }))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0]
      if (!queued) return null
      const claimed = transitionAudit(queued, 'starting', { workerId, message: 'Worker claimed queued audit' }, now)
      claimed.version = queued.version + 1
      await this._writeUnlocked(claimed)
      this.emit('changed', clone(claimed))
      return clone(claimed)
    })
  }

  async putEvidence(auditId, { buffer, contentType = 'image/png', label = 'evidence' }) {
    await this._init()
    const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'evidence'
    const extension = contentType === 'image/jpeg' ? 'jpg' : 'png'
    const folder = path.join(this.evidenceDirectory, String(auditId).toUpperCase())
    await fs.mkdir(folder, { recursive: true })
    const fileName = `${Date.now()}-${safeLabel}.${extension}`
    await fs.writeFile(path.join(folder, fileName), buffer)
    return `evidence/${String(auditId).toUpperCase()}/${fileName}`
  }

  async getEvidence(reference) {
    const normalized = path.normalize(String(reference || '')).replaceAll('\\', '/')
    if (!/^evidence\/FBA-[A-F0-9]{8}\/[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error('Invalid evidence reference')
    const resolved = path.resolve(this.directory, normalized)
    if (!resolved.startsWith(`${this.evidenceDirectory}${path.sep}`)) throw new Error('Invalid evidence reference')
    return fs.readFile(resolved)
  }
}

function createAuditStoreFromEnv(options = {}) {
  if (process.env.FACEBOOK_AUDIT_STORE === 'memory') return new MemoryAuditStore()
  if (process.env.FACEBOOK_AUDIT_STORE === 'file') {
    return new FileAuditStore({
      directory: options.directory || process.env.FACEBOOK_AUDIT_DATA_DIR || path.join(process.cwd(), 'data', 'facebook-audits')
    })
  }
  const { VercelBlobAuditStore } = require('./vercel-blob-audit-store')
  return new VercelBlobAuditStore({ token: options.token || process.env.BLOB_READ_WRITE_TOKEN })
}

module.exports = {
  FileAuditStore,
  MemoryAuditStore,
  VersionConflictError,
  createAuditStoreFromEnv
}
