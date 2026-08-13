class MultiAuditWorker {
  constructor(workers = []) {
    this.workers = workers.filter(Boolean)
    if (!this.workers.length) throw new Error('MultiAuditWorker requires at least one worker')
    this.nextIndex = 0
  }

  async processNext() {
    for (let offset = 0; offset < this.workers.length; offset += 1) {
      const index = (this.nextIndex + offset) % this.workers.length
      const result = await this.workers[index].processNext()
      if (result) {
        this.nextIndex = (index + 1) % this.workers.length
        return result
      }
    }
    this.nextIndex = (this.nextIndex + 1) % this.workers.length
    return null
  }
}

module.exports = { MultiAuditWorker }
