const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { FacebookAuditJournal } = require('../worker/journal')

test('journal reads durable entries when the final NDJSON line is truncated', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-journal-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'worker.ndjson')
  const first = { type: 'browser_send_completed', auditId: 'FBA-FIRST', attemptId: 'attempt-1' }
  await fs.writeFile(filePath, `${JSON.stringify(first)}\n{"type":"browser_send_completed","auditId":"FBA-BROKEN"`, 'utf8')

  const entries = await new FacebookAuditJournal(filePath).read()

  assert.deepEqual(entries, [first])
})

test('journal still rejects a malformed complete NDJSON line', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-journal-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'worker.ndjson')
  await fs.writeFile(filePath, '{"type":"broken"}\nnot-json\n', 'utf8')

  await assert.rejects(() => new FacebookAuditJournal(filePath).read(), SyntaxError)
})
