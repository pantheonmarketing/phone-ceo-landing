const { EventEmitter } = require('node:events')

class AuditWorkerController extends EventEmitter {
  constructor({ worker, pollIntervalMs = 3000 }) {
    super()
    this.worker = worker
    this.pollIntervalMs = Math.max(500, Number(pollIntervalMs) || 3000)
    this.paused = false
    this.running = false
    this.processing = false
    this.timer = null
    this.state = 'idle'
    this.lastPollAt = null
    this.activeAuditId = null
    this.lastError = null
  }

  getStatus() {
    return {
      state: this.state,
      paused: this.paused,
      processing: this.processing,
      lastPollAt: this.lastPollAt,
      activeAuditId: this.activeAuditId,
      lastError: this.lastError
    }
  }

  _changed() {
    this.emit('changed', this.getStatus())
  }

  start() {
    if (this.running) return
    this.running = true
    this._schedule(0)
  }

  pause() {
    this.paused = true
    if (!this.processing) this.state = 'paused'
    this._changed()
  }

  resume() {
    this.paused = false
    if (!this.processing) this.state = 'idle'
    this._changed()
    if (this.running) this._schedule(0)
  }

  async stop() {
    this.running = false
    clearTimeout(this.timer)
    this.timer = null
    while (this.processing) await new Promise(resolve => setTimeout(resolve, 25))
    this.state = 'stopped'
    this._changed()
  }

  _schedule(delay) {
    clearTimeout(this.timer)
    if (!this.running) return
    this.timer = setTimeout(() => this._tick(), delay)
  }

  async _tick() {
    if (!this.running || this.processing) return
    if (this.paused) {
      this.state = 'paused'
      this._changed()
      return this._schedule(this.pollIntervalMs)
    }

    this.processing = true
    this.state = 'busy'
    this.lastPollAt = new Date().toISOString()
    this.lastError = null
    this._changed()
    let processed = false
    try {
      const result = await this.worker.processNext()
      processed = Boolean(result)
      this.activeAuditId = result && !['passed', 'failed', 'error'].includes(result.status) ? result.auditId : null
      this.state = 'idle'
    } catch (error) {
      this.state = 'error'
      this.lastError = error.code ? `Worker polling failed (${String(error.code).slice(0, 80)})` : 'Worker polling failed'
    } finally {
      this.processing = false
      this.activeAuditId = null
      if (this.paused) this.state = 'paused'
      this._changed()
      this._schedule(processed ? 100 : this.pollIntervalMs)
    }
  }
}

module.exports = { AuditWorkerController }
