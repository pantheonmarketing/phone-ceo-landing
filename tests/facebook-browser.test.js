const test = require('node:test')
const assert = require('node:assert/strict')

const { FacebookMessengerBrowser, selectNewConversationEntries } = require('../worker/facebook-messenger-browser')
const { installFixtureRoutes } = require('../scripts/facebook-audit-smoke')

test('controlled smoke routes both Facebook hosts through the fixture', async () => {
  const routes = []
  let sent = 0
  const context = {
    async route(pattern, handler) {
      routes.push({ pattern, handler })
    }
  }
  const fixture = { html: () => '<fixture>', recordSend: () => { sent += 1 } }

  await installFixtureRoutes(context, fixture)

  assert.deepEqual(routes.map(route => route.pattern), [
    'https://facebook.com/**',
    'https://www.facebook.com/**'
  ])
  let sendResponse
  await routes[0].handler({
    request: () => ({ url: () => 'https://facebook.com/fixture-send' }),
    fulfill: async response => { sendResponse = response }
  })
  assert.deepEqual(sendResponse, { status: 204, body: '' })
  assert.equal(sent, 1)
  let pageResponse
  await routes[1].handler({
    request: () => ({ url: () => 'https://www.facebook.com/me' }),
    fulfill: async response => { pageResponse = response }
  })
  assert.deepEqual(pageResponse, { status: 200, contentType: 'text/html; charset=utf-8', body: '<fixture>' })
})

test('sendMessage timestamps only after conversation verification', async () => {
  let verified = false
  let nowCalls = 0
  const browser = new FacebookMessengerBrowser({
    profileDirectory: 'test-profile',
    now: () => {
      nowCalls += 1
      assert.equal(verified, true)
      return new Date('2026-08-13T08:00:06.000Z')
    }
  })
  browser.auditId = 'FBA-ABCDEF12'
  browser.composer = {
    async fill() {},
    async press() {}
  }
  browser.page = { waitForTimeout: async () => {} }
  browser._collectEntries = async () => {
    verified = true
    return ['Audit ID: FBA-ABCDEF12']
  }

  const result = await browser.sendMessage('Audit question', { auditId: 'FBA-ABCDEF12' })

  assert.equal(nowCalls, 1)
  assert.equal(result.sentAt, '2026-08-13T08:00:06.000Z')
})

test('openPage fails closed when the navigated host is not Facebook', async () => {
  let actualUrl = 'https://example.com/example'
  const page = {
    async goto(url) {
      if (String(url).endsWith('/me')) actualUrl = 'https://www.facebook.com/login/?next=%2Fme'
    },
    async waitForTimeout() {},
    url: () => actualUrl,
    locator: () => ({
      first() { return this },
      async isVisible() { return false }
    })
  }
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  browser.launch = async () => ({ pages: () => [page], newPage: async () => page })

  const result = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://fb.com/example' })

  assert.equal(result.loggedIn, false)
  assert.equal(result.reason, 'facebook_page_host_unverified')

  actualUrl = 'https://fb.com/example'
  const missingLoginEvidence = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://fb.com/example' })
  assert.equal(missingLoginEvidence.loggedIn, false)
})

test('openPage requires the Facebook /me session check rather than public profile markup', async () => {
  let actualUrl = 'https://www.facebook.com/example'
  const page = {
    async goto(url) {
      if (String(url).endsWith('/me')) actualUrl = 'https://www.facebook.com/profile.php?id=123'
    },
    url: () => actualUrl,
    locator: () => ({
      first() { return this },
      async isVisible() { return false }
    })
  }
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  browser.launch = async () => ({ pages: () => [page], newPage: async () => page })

  const result = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://www.facebook.com/example' })

  assert.equal(result.loggedIn, true)
  assert.equal(result.dedicatedProfileSelected, true)
})

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
