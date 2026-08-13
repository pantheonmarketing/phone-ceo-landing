const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord } = require('../lib/facebook-audit-state')
const { FileAuditStore, MemoryAuditStore } = require('../lib/facebook-audit-store')
const { normalizeBlobEtag, VercelBlobAuditStore } = require('../lib/vercel-blob-audit-store')

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

test('FileAuditStore claims the oldest queued audit beyond the display window', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-queue-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new FileAuditStore({ directory })
  const oldestAt = new Date('2026-08-13T08:00:00.000Z')
  const records = Array.from({ length: 101 }, (_, index) => makeRecord(
    index === 0 ? 'Oldest Queued Business' : `Queued Business ${index}`,
    new Date(oldestAt.getTime() + index * 1000)
  ))
  for (const record of records) await store.create(record)

  const claimed = await store.claimNext('worker-a', new Date('2026-08-13T09:00:00.000Z'))

  assert.equal(claimed.requestedAt, oldestAt.toISOString())
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

test('FileAuditStore does not expose a partially written record to concurrent readers', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-audit-store-read-lock-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new FileAuditStore({ directory })
  const record = makeRecord('Concurrent Read Business', new Date('2026-08-13T08:00:00.000Z'))
  await store.create(record)

  const originalWrite = store._writeUnlocked.bind(store)
  let releaseWrite
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  let partialWritten
  const partialReady = new Promise(resolve => { partialWritten = resolve })
  store._writeUnlocked = async next => {
    await fs.writeFile(store._recordPath(next.auditId), '{"incomplete":', 'utf8')
    partialWritten()
    await writeGate
    return originalWrite(next)
  }

  const update = store.update(record.auditId, current => ({ ...current, businessName: 'Updated safely' }))
  await partialReady
  const read = store.get(record.auditId)
  let earlyOutcome = null
  read.then(
    () => { earlyOutcome = 'resolved' },
    error => { earlyOutcome = error }
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(earlyOutcome, null)
  releaseWrite()

  const [, stored] = await Promise.all([update, read])
  assert.equal(stored.businessName, 'Updated safely')
})

test('Vercel Blob weak read ETags are normalized for conditional writes', () => {
  assert.equal(normalizeBlobEtag('W/"abc123"'), '"abc123"')
  assert.equal(normalizeBlobEtag('"abc123"'), '"abc123"')
})

test('Vercel Blob listing continues past nonmatching records', async () => {
  const terminal = [
    makeRecord('Terminal One', new Date('2026-08-13T08:00:00.000Z')),
    makeRecord('Terminal Two', new Date('2026-08-13T08:01:00.000Z')),
    makeRecord('Terminal Three', new Date('2026-08-13T08:02:00.000Z'))
  ]
  terminal.forEach(record => { record.status = 'passed' })
  const queued = makeRecord('Queued Beyond First Page', new Date('2026-08-13T08:03:00.000Z'))
  const records = new Map([...terminal, queued].map(record => [
    `facebook-audits/records/${record.auditId}.json`, record
  ]))
  let listCalls = 0
  const blob = {
    async list() {
      listCalls += 1
      return listCalls === 1
        ? { blobs: terminal.map(record => ({ pathname: `facebook-audits/records/${record.auditId}.json` })), hasMore: true, cursor: 'next' }
        : { blobs: [{ pathname: `facebook-audits/records/${queued.auditId}.json` }], hasMore: false }
    },
    async get(pathname) {
      const record = records.get(pathname)
      return { statusCode: 200, stream: Readable.from([JSON.stringify(record)]), blob: { etag: '"test"' } }
    }
  }
  const store = new VercelBlobAuditStore({ token: 'test', blob })

  const result = await store.list({ statuses: ['queued'], limit: 1 })

  assert.equal(listCalls, 2)
  assert.deepEqual(result.map(record => record.auditId), [queued.auditId])
})

test('Vercel Blob claim listing can scan the full durable queue', async () => {
  const oldQueued = makeRecord('Old Queued Business', new Date('2026-08-13T08:00:00.000Z'))
  const newerQueued = makeRecord('New Queued Business', new Date('2026-08-13T08:01:00.000Z'))
  const records = new Map([
    [`facebook-audits/records/${oldQueued.auditId}.json`, oldQueued],
    [`facebook-audits/records/${newerQueued.auditId}.json`, newerQueued]
  ])
  let listCalls = 0
  const blob = {
    async list(options) {
      assert.equal(options.limit, 1000)
      listCalls += 1
      return listCalls === 1
        ? { blobs: [{ pathname: `facebook-audits/records/${newerQueued.auditId}.json` }], hasMore: true, cursor: 'next' }
        : { blobs: [{ pathname: `facebook-audits/records/${oldQueued.auditId}.json` }], hasMore: false }
    },
    async get(pathname) {
      const record = records.get(pathname)
      return { statusCode: 200, stream: Readable.from([JSON.stringify(record)]), blob: { etag: '"test"' } }
    }
  }
  const store = new VercelBlobAuditStore({ token: 'test', blob })

  const queued = await store.list({ statuses: ['queued'], limit: null })

  assert.equal(listCalls, 2)
  assert.deepEqual(queued.map(record => record.auditId), [newerQueued.auditId, oldQueued.auditId])
})

test('Vercel Blob rate limiting is shared and bounded to one conditional record', async () => {
  let value = null
  let etag = 0
  const blob = {
    async get() {
      if (!value) return null
      return {
        statusCode: 200,
        stream: Readable.from([value]),
        blob: { etag: `"${etag}"` }
      }
    },
    async put(pathname, body, options) {
      assert.equal(pathname, 'facebook-audits/rate-limit/public-posts.json')
      if (value && options.ifMatch !== `"${etag}"`) throw Object.assign(new Error('precondition failed'), { status: 412 })
      if (!value && options.allowOverwrite) throw Object.assign(new Error('already exists'), { status: 409 })
      value = body
      etag += 1
    }
  }
  const store = new VercelBlobAuditStore({ token: 'test', blob })

  assert.equal((await store.consumeRateLimit({ limit: 2, windowMs: 60000, key: 'first' })).allowed, true)
  assert.equal((await store.consumeRateLimit({ limit: 2, windowMs: 60000, key: 'second' })).allowed, true)
  const blocked = await store.consumeRateLimit({ limit: 2, windowMs: 60000, key: 'rotated-client' })
  assert.equal(blocked.allowed, false)
  assert.equal(etag, 2)
})
