const fs = require('node:fs/promises')
const path = require('node:path')

class FacebookAuditJournal {
  constructor(filePath) {
    if (!filePath) throw new Error('A worker journal path is required')
    this.filePath = path.resolve(filePath)
  }

  async append(entry) {
    const safe = {
      type: String(entry.type || '').slice(0, 80),
      auditId: String(entry.auditId || '').slice(0, 32),
      attemptId: String(entry.attemptId || '').slice(0, 80),
      sentAt: entry.sentAt ? new Date(entry.sentAt).toISOString() : null,
      recordedAt: new Date().toISOString()
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.appendFile(this.filePath, `${JSON.stringify(safe)}\n`, 'utf8')
  }

  async read() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const lines = content.split(/\r?\n/)
      const entries = []
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!line) continue
        try {
          entries.push(JSON.parse(line))
        } catch (error) {
          const isTrailingIncompleteLine = index === lines.length - 1 && !/\r?\n$/.test(content)
          if (isTrailingIncompleteLine && error instanceof SyntaxError) break
          throw error
        }
      }
      return entries
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }
}

module.exports = { FacebookAuditJournal }
