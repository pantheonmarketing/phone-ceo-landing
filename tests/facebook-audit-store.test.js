const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord } = require('../lib/facebook-audit-state')
const { FileAuditStore, MemoryAuditStore } = require('../lib/facebook-audit-store')
const { normalizeBlobEtag } = require('../lib/vercel-blob-audit-store')

function makeRecord(name, now) {
  const request = buildAuditRequest({
    businessName: name,
    pageUrl: `https://facebook.com/${name.toLowerCase().replace(/\s/g, '')}`,
    customerQuestion: 'Are you available?',
    authorized: true
  }, now)
  return createAuditRecord(request, hashReportToken(createReportToken()))
}

test('MemoryAuditStore claims one queued audit atomically', async () => {
  const store = new MemoryAuditStore()
  const first = makeRecord('First Business', new Date('2026-08-13T08:00:00.000Z'))
  const second = makeRecord('Second Business', new Date('2026-08-13T08:01:00.000Z'))
  await store.create(first)
  await store.create(second)

  const [claimA, claimB] = await Promise.all([
    store.claimNext('worker-a', new Date('2026-08-13T08:02:00.000Z')),
    store.claimNext('worker-b', new Date('2026-08-13T08:02:00.000Z'))
  ])

  assert.notEqual(claimA.auditId, claimB.auditId)
  assert.equal(claimA.status, 'starting')
  assert.equal(claimB.status, 'starting')
  assert.equal(new Set([claimA.claimedBy, claimB.claimedBy]).size, 2)
})

test('MemoryAuditStore update enforces expected version', async () => {
  const store = new MemoryAuditStore()
  const audit = makeRecord('Versioned Business', new Date('2026-08-13T08:00:00.000Z'))
  await store.create(audit)

  const updated = await store.update(audit.auditId, current => ({ ...current, businessName: 'Updated' }), audit.version)
  assert.equal(updated.version, audit.version + 1)
  await assert.rejects(
    store.update(audit.auditId, current => current, audit.version),
    /version conflict/i
  )
})

test('FileAuditStore persists queue records across store instances', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-store-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const record = makeRecord('Durable Business', new Date('2026-08-13T08:00:00.000Z'))

  await new FileAuditStore({ directory }).create(record)
  const reopened = new FileAuditStore({ directory })
  const stored = await reopened.get(record.auditId)

  assert.equal(stored.auditId, record.auditId)
  assert.equal(stored.status, 'queued')
  assert.equal(stored.events[0].type, 'submitted')
})

test('Vercel Blob weak read ETags are normalized for conditional writes', () => {
  assert.equal(normalizeBlobEtag('W/"abc123"'), '"abc123"')
  assert.equal(normalizeBlobEtag('"abc123"'), '"abc123"')
})
