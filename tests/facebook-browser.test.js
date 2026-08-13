const test = require('node:test')
const assert = require('node:assert/strict')

const { selectNewConversationEntries } = require('../worker/facebook-messenger-browser')

test('selectNewConversationEntries ignores baseline and the worker message without losing new replies', () => {
  const baseline = new Set(['Older customer message', 'Older business reply'])
  const current = [
    'Older customer message',
    'Older business reply',
    'Audit question Audit ID: FBA-ABCDEF12',
    'Yes, Friday is available for $50.'
  ]

  assert.deepEqual(selectNewConversationEntries({
    baseline,
    current,
    sentMessage: 'Audit question Audit ID: FBA-ABCDEF12',
    auditId: 'FBA-ABCDEF12',
    seen: new Set()
  }), ['Yes, Friday is available for $50.'])
})
