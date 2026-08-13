const test = require('node:test')
const assert = require('node:assert/strict')

const { buildWebsiteAuditRequest, createReportToken, hashReportToken } = require('../lib/website-audit')
const {
  applyWebsiteReply,
  completeWebsiteAudit,
  confirmWebsiteMessageSent,
  createWebsiteAuditRecord,
  prepareWebsiteMessageSend,
  publicWebsiteAuditView,
  recordWebsiteFindings,
  transitionWebsiteAudit
} = require('../lib/website-audit-state')

function request() {
  return buildWebsiteAuditRequest({
    businessName: 'State Business',
    websiteUrl: 'https://example.com',
    customerQuestion: 'What does it cost?',
    authorized: true
  }, new Date('2026-08-13T09:00:00.000Z'))
}

test('website audit state records the real inspection and one confirmed chat send', () => {
  const token = createReportToken()
  let audit = createWebsiteAuditRecord(request(), hashReportToken(token))
  audit = transitionWebsiteAudit(audit, 'starting', { workerId: 'worker-1' }, new Date('2026-08-13T09:00:01.000Z'))
  audit = transitionWebsiteAudit(audit, 'mapping', {}, new Date('2026-08-13T09:00:02.000Z'))
  audit = recordWebsiteFindings(audit, {
    pageReachable: true,
    contactMethods: ['chat', 'email'],
    contactClicks: 0,
    contactFormFieldCount: 4,
    chatAvailable: true,
    chatProvider: 'test-widget'
  }, new Date('2026-08-13T09:00:03.000Z'))
  audit = transitionWebsiteAudit(audit, 'testing', {}, new Date('2026-08-13T09:00:04.000Z'))
  audit = prepareWebsiteMessageSend(audit, 'attempt-1', new Date('2026-08-13T09:00:05.000Z'))
  audit = confirmWebsiteMessageSent(audit, 'attempt-1', new Date('2026-08-13T09:00:06.000Z'))

  assert.equal(audit.status, 'waiting')
  assert.equal(audit.sentAt, '2026-08-13T09:00:06.000Z')
  assert.equal(audit.deadlineAt, '2026-08-13T09:01:06.000Z')
  assert.equal(audit.sendGuard.state, 'sent')

  audit = applyWebsiteReply(audit, {
    text: 'It is $50. Would you like to book a call?',
    receivedAt: new Date('2026-08-13T09:00:26.000Z'),
    classification: { isUseful: true, hasQualificationQuestion: true, hasClearNextAction: true }
  })
  audit = completeWebsiteAudit(audit, {
    total: 100,
    grade: 'A',
    label: 'A ready buyer can get useful help immediately'
  }, new Date('2026-08-13T09:00:26.000Z'))

  assert.equal(audit.status, 'completed')
  assert.equal(audit.score.total, 100)
  assert.equal(audit.replies.length, 1)
  assert.equal(audit.observations.usefulReply, true)
  assert.equal(publicWebsiteAuditView(audit, token).score.total, 100)
  assert.equal(publicWebsiteAuditView(audit, 'wrong'), null)
})

test('website audit can complete honestly without sending when no live chat exists', () => {
  let audit = createWebsiteAuditRecord(request(), hashReportToken(createReportToken()))
  audit = transitionWebsiteAudit(audit, 'starting')
  audit = transitionWebsiteAudit(audit, 'mapping')
  audit = recordWebsiteFindings(audit, {
    pageReachable: true,
    contactMethods: ['contact_form'],
    contactClicks: 1,
    contactFormFieldCount: 8,
    chatAvailable: false
  })
  audit = transitionWebsiteAudit(audit, 'testing')
  audit = completeWebsiteAudit(audit, { total: 32, grade: 'D', label: 'Buyers face avoidable friction' })

  assert.equal(audit.status, 'completed')
  assert.equal(audit.sentAt, null)
  assert.equal(audit.sendGuard.state, 'not_available')
})
