const test = require('node:test')
const assert = require('node:assert/strict')

const {
  WEBSITE_RESPONSE_MS,
  buildWebsiteAuditRequest,
  calculateWebsiteAuditScore,
  normalizeWebsiteUrl
} = require('../lib/website-audit')

test('website audit request accepts an authorized public website and preserves one buyer question', () => {
  const request = buildWebsiteAuditRequest({
    businessName: 'Example Business',
    websiteUrl: 'https://example.com/contact?utm_source=audit#hello',
    customerQuestion: 'Do you have availability this week?',
    authorized: true
  }, new Date('2026-08-13T09:00:00.000Z'))

  assert.match(request.auditId, /^WBA-[A-F0-9]{8}$/)
  assert.equal(request.websiteUrl, 'https://example.com/contact')
  assert.equal(request.testMessage, 'Do you have availability this week?')
  assert.equal(request.deadlineAt, null)
  assert.doesNotMatch(request.testMessage, /audit|WBA-/i)
  assert.match(request.disclosureMessage, /authorized customer-response audit/i)
  assert.match(request.disclosureMessage, new RegExp(request.auditId))
})

test('website URL validation blocks credentials and non-public network targets', () => {
  for (const value of [
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.0.0.8',
    'http://192.168.1.4',
    'http://172.16.1.2',
    'https://alice:secret@example.com',
    'file:///etc/passwd'
  ]) {
    assert.throws(() => normalizeWebsiteUrl(value), /public website URL/i)
  }
})

test('website audit rejects missing authorization and abusive buyer questions', () => {
  assert.throws(() => buildWebsiteAuditRequest({ websiteUrl: 'https://example.com' }), /authorization/i)
  assert.throws(() => buildWebsiteAuditRequest({
    websiteUrl: 'https://example.com',
    customerQuestion: 'Why is your service so f*cking bad?',
    authorized: true
  }), /without abusive or offensive language/i)
})

test('website scoring is explainable and totals one hundred for a frictionless useful chat', () => {
  const score = calculateWebsiteAuditScore({
    pageReachable: true,
    contactClicks: 0,
    chatAvailable: true,
    messageSent: true,
    responseSeconds: 20,
    usefulReply: true,
    qualificationQuestion: true,
    clearNextAction: true
  })

  assert.deepEqual(score, {
    total: 100,
    grade: 'A',
    label: 'A ready buyer can get useful help immediately',
    reachability: 20,
    buyerFriction: 15,
    instantHelp: 25,
    answerQuality: 25,
    qualificationNextAction: 15,
    responseSeconds: 20,
    method: 'website-buyer-journey-v1'
  })
})

test('website scoring records visible contact friction without pretending a chat response happened', () => {
  const score = calculateWebsiteAuditScore({
    pageReachable: true,
    contactClicks: 1,
    chatAvailable: false,
    messageSent: false,
    bookingAvailable: true
  })

  assert.equal(score.total, 39)
  assert.equal(score.grade, 'D')
  assert.equal(score.reachability, 20)
  assert.equal(score.buyerFriction, 12)
  assert.equal(score.instantHelp, 0)
  assert.equal(score.answerQuality, 0)
  assert.equal(score.qualificationNextAction, 7)
  assert.equal(score.responseSeconds, null)
  assert.equal(WEBSITE_RESPONSE_MS, 60000)
})

test('website audit is unscored when the public page was not actually reached', () => {
  assert.equal(calculateWebsiteAuditScore({ pageReachable: false }), null)
})
