const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAuditRequest, createReportToken, hashReportToken } = require('../lib/facebook-audit')
const { createAuditRecord } = require('../lib/facebook-audit-state')
const { MemoryAuditStore } = require('../lib/facebook-audit-store')
const { AuditWorker } = require('../worker/audit-worker')

function testClock(start = '2026-08-13T08:00:09.000Z') {
  let value = start
  return {
    now: () => new Date(value),
    set: next => { value = next }
  }
}

async function queuedAudit(store) {
  const request = buildAuditRequest({
    businessName: 'Example Business',
    pageUrl: 'https://facebook.com/examplebusiness',
    customerQuestion: 'Do you have availability this week and what does it cost?',
    authorized: true
  }, new Date('2026-08-13T08:00:00.000Z'))
  const record = createAuditRecord(request, hashReportToken(createReportToken()))
  await store.create(record)
  return record
}

test('worker sends once, records a useful reply, passes, and notifies', async () => {
  const store = new MemoryAuditStore()
  const initial = await queuedAudit(store)
  const clock = testClock()
  const journal = []
  const notifications = []
  let sends = 0
  const browser = {
    async openPage() { return { loggedIn: true, dedicatedProfileSelected: true } },
    async openMessenger() { return { reachable: true } },
    async captureEvidence() { return null },
    async sendMessage(message) {
      sends += 1
      assert.match(message, new RegExp(initial.auditId))
      clock.set('2026-08-13T08:00:10.000Z')
      return { sentAt: '2026-08-13T08:00:10.000Z' }
    },
    async observeUntil({ onReply }) {
      await onReply({
        text: 'Yes, Friday is available for $50. Would you like me to book it?',
        receivedAt: '2026-08-13T08:00:50.000Z'
      })
      return { observedUntil: '2026-08-13T08:00:50.000Z' }
    },
    async closeAudit() {}
  }
  const worker = new AuditWorker({
    store,
    browser,
    workerId: 'worker-test',
    journal: { append: entry => journal.push(entry) },
    notifyFinal: async audit => notifications.push(audit),
    now: clock.now
  })

  const result = await worker.processNext()
  assert.equal(result.status, 'passed')
  assert.equal(result.score.grade, 'A')
  assert.equal(sends, 1)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].type, 'browser_send_completed')
  const opened = await store.get(initial.auditId)
  const pageOpened = opened.events.find(event => event.type === 'page_opened')
  assert.equal(pageOpened.dedicatedProfileSelected, true)
  assert.equal('profileIsolationConfirmed' in pageOpened, false)
  assert.match(pageOpened.message, /manual acceptance check/i)
  assert.equal(notifications.length, 1)
})

test('worker marks login failure as an unscored error', async () => {
  const store = new MemoryAuditStore()
  await queuedAudit(store)
  const browser = {
    async openPage() { return { loggedIn: false } },
    async closeAudit() {}
  }
  const worker = new AuditWorker({
    store,
    browser,
    workerId: 'worker-test',
    journal: { append() {} },
    notifyFinal: async () => {}
  })

  const result = await worker.processNext()
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'facebook_login_required')
  assert.equal(result.score, null)
  assert.equal(result.sentAt, null)
})

test('worker fails unscored when profile selection evidence is absent', async () => {
  const store = new MemoryAuditStore()
  await queuedAudit(store)
  let sends = 0
  const browser = {
    async openPage() { return { loggedIn: true } },
    async openMessenger() { sends += 1; return { reachable: true } },
    async closeAudit() {}
  }
  const worker = new AuditWorker({ store, browser, workerId: 'worker-test', notifyFinal: async () => {} })
  const result = await worker.processNext()
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'facebook_profile_not_selected')
  assert.equal(result.score, null)
  assert.equal(sends, 0)
})

test('worker applies the hard F rule after a sent message receives only an auto reply', async () => {
  const store = new MemoryAuditStore()
  await queuedAudit(store)
  const clock = testClock()
  const browser = {
    async openPage() { return { loggedIn: true, dedicatedProfileSelected: true } },
    async openMessenger() { return { reachable: true } },
    async captureEvidence() { return null },
    async sendMessage() {
      clock.set('2026-08-13T08:00:10.000Z')
      return { sentAt: '2026-08-13T08:00:10.000Z' }
    },
    async observeUntil({ onReply }) {
      await onReply({
        text: 'Thanks for contacting us. We will get back to you soon.',
        receivedAt: '2026-08-13T08:00:11.000Z'
      })
      return { observedUntil: '2026-08-13T08:02:10.000Z' }
    },
    async closeAudit() {}
  }
  const worker = new AuditWorker({
    store,
    browser,
    workerId: 'worker-test',
    journal: { append() {} },
    notifyFinal: async () => {},
    now: clock.now
  })

  const result = await worker.processNext()
  assert.equal(result.status, 'failed')
  assert.equal(result.score.grade, 'F')
  assert.equal(result.score.behaviorBand, 'C')
})

test('worker records a useful late reply without changing the F result', async () => {
  const store = new MemoryAuditStore()
  const initial = await queuedAudit(store)
  const clock = testClock()
  const lateNotifications = []
  let observations = 0
  const browser = {
    async openPage() { return { loggedIn: true, dedicatedProfileSelected: true } },
    async openMessenger() { return { reachable: true } },
    async captureEvidence() { return null },
    async sendMessage() {
      clock.set('2026-08-13T08:00:10.000Z')
      return { sentAt: '2026-08-13T08:00:10.000Z' }
    },
    async observeUntil({ onReply }) {
      observations += 1
      if (observations === 1) return { observedUntil: '2026-08-13T08:02:10.000Z' }
      await onReply({
        text: 'The next event is Sunday at 10 AM. Which date works best for you?',
        receivedAt: '2026-08-13T08:08:00.000Z'
      })
      return { observedUntil: '2026-08-13T08:08:00.000Z' }
    },
    async closeAudit() {}
  }
  const worker = new AuditWorker({
    store,
    browser,
    workerId: 'worker-test',
    journal: { append() {} },
    notifyFinal: async () => {},
    notifyLate: async (audit, reply) => lateNotifications.push({ audit, reply }),
    lateReplyWindowMs: 10 * 60 * 1000,
    now: clock.now
  })

  const result = await worker.processNext()

  assert.equal(result.auditId, initial.auditId)
  assert.equal(result.status, 'failed')
  assert.equal(result.score.grade, 'F')
  assert.equal(result.replies.length, 1)
  assert.equal(result.replies[0].isLate, true)
  assert.equal(result.replies[0].classification.isUseful, true)
  assert.equal(result.replies[0].classification.hasQualificationQuestion, true)
  assert.equal(lateNotifications.length, 1)
  assert.equal(observations, 2)
  assert.deepEqual(result.events.slice(-3).map(event => event.type), [
    'late_reply_monitoring', 'late_reply_detected', 'late_reply_window_closed'
  ])
})
