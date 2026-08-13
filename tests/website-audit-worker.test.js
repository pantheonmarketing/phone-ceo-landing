const test = require('node:test')
const assert = require('node:assert/strict')

const { buildWebsiteAuditRequest, createReportToken, hashReportToken } = require('../lib/website-audit')
const { createWebsiteAuditRecord } = require('../lib/website-audit-state')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')
const { WebsiteAuditWorker } = require('../worker/website-audit-worker')

async function queued(store) {
  const request = buildWebsiteAuditRequest({
    businessName: 'Worker Business',
    websiteUrl: 'https://example.com',
    customerQuestion: 'What does it cost?',
    authorized: true
  })
  await store.create(createWebsiteAuditRecord(request, hashReportToken(createReportToken())))
  return request.auditId
}

test('website worker maps contact paths and completes without submitting a form when chat is absent', async () => {
  const store = new MemoryAuditStore()
  const auditId = await queued(store)
  let closed = false
  const browser = {
    async openWebsite() { return { reachable: true, pageLoadMs: 800 } },
    async inspectBuyerJourney() {
      return {
        pageReachable: true,
        contactMethods: ['contact_form', 'booking'],
        contactClicks: 1,
        contactFormFieldCount: 7,
        bookingAvailable: true,
        chatAvailable: false
      }
    },
    async captureEvidence() { return null },
    async closeAudit() { closed = true }
  }
  const worker = new WebsiteAuditWorker({ store, browser })

  const result = await worker.processNext()

  assert.equal(result.auditId, auditId)
  assert.equal(result.status, 'completed')
  assert.equal(result.sentAt, null)
  assert.equal(result.observations.contactFormFieldCount, 7)
  assert.equal(result.score.total, 39)
  assert.equal(closed, true)
})

test('website worker sends one chat question, records a useful reply, and discloses after the reply', async () => {
  const store = new MemoryAuditStore()
  const auditId = await queued(store)
  const sent = []
  const browser = {
    async openWebsite() { return { reachable: true, pageLoadMs: 500 } },
    async inspectBuyerJourney() {
      return { pageReachable: true, contactMethods: ['chat'], contactClicks: 0, chatAvailable: true, chatProvider: 'fixture' }
    },
    async sendMessage(message) { sent.push(message); return { sentAt: '2026-08-13T09:00:00.000Z' } },
    async observeUntil({ onReply }) {
      await onReply({ text: 'It is $50. Would you like to book?', receivedAt: '2026-08-13T09:00:20.000Z' })
      return { observedUntil: '2026-08-13T09:00:20.000Z' }
    },
    async sendAuditDisclosure(message) { sent.push(message); return { sentAt: '2026-08-13T09:00:21.000Z' } },
    async captureEvidence() { return null },
    async closeAudit() {}
  }
  const worker = new WebsiteAuditWorker({ store, browser, now: () => new Date('2026-08-13T09:00:00.000Z') })

  const result = await worker.processNext()

  assert.equal(result.auditId, auditId)
  assert.equal(result.status, 'completed')
  assert.equal(result.score.total, 100)
  assert.equal(result.replies.length, 1)
  assert.equal(sent.length, 2)
  assert.equal(sent[0], 'What does it cost?')
  assert.match(sent[1], /authorized customer-response audit/i)
})

test('website worker never retries an ambiguous chat send and reports an unscored error', async () => {
  const store = new MemoryAuditStore()
  await queued(store)
  let sends = 0
  const browser = {
    async openWebsite() { return { reachable: true } },
    async inspectBuyerJourney() { return { pageReachable: true, contactMethods: ['chat'], contactClicks: 0, chatAvailable: true } },
    async sendMessage() { sends += 1; throw Object.assign(new Error('unknown'), { code: 'website_chat_send_unconfirmed' }) },
    async captureEvidence() { return null },
    async closeAudit() {}
  }
  const worker = new WebsiteAuditWorker({ store, browser })

  const result = await worker.processNext()

  assert.equal(result.status, 'error')
  assert.equal(result.score, null)
  assert.equal(result.error.code, 'website_chat_send_unconfirmed')
  assert.equal(sends, 1)
})

test('website worker fails safely when buyer-path mapping exceeds its deadline', async () => {
  const store = new MemoryAuditStore()
  await queued(store)
  let closed = false
  const browser = {
    async openWebsite() { return { reachable: true } },
    async inspectBuyerJourney() { return new Promise(() => {}) },
    async captureEvidence() { return null },
    async closeAudit() { closed = true }
  }
  const worker = new WebsiteAuditWorker({ store, browser, mappingTimeoutMs: 10 })

  const result = await worker.processNext()

  assert.equal(result.status, 'error')
  assert.equal(result.score, null)
  assert.equal(result.error.code, 'website_mapping_timeout')
  assert.match(result.error.message, /contact-path mapping took too long/i)
  assert.equal(closed, true)
})
