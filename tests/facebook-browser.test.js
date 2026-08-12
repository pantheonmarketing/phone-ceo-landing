const test = require('node:test')
const assert = require('node:assert/strict')

const { FacebookMessengerBrowser, selectNewConversationEntries } = require('../worker/facebook-messenger-browser')
const { configureFixtureBrowser, installFixtureRoutes } = require('../scripts/facebook-audit-smoke')

test('controlled smoke installs fixture routes when the worker launches the browser', async () => {
  let launches = 0
  let routeCalls = 0
  const context = {
    async route() {
      routeCalls += 1
    }
  }
  const browser = {
    async launch() {
      launches += 1
      return context
    }
  }

  assert.equal(configureFixtureBrowser(browser, { html: () => '<fixture>' }), browser)
  assert.equal(await browser.launch(), context)
  assert.equal(await browser.launch(), context)
  assert.equal(launches, 2)
  assert.equal(routeCalls, 2)
})

test('controlled smoke routes both Facebook hosts through the fixture', async () => {
  const routes = []
  let sent = 0
  const context = {
    async route(pattern, handler) {
      routes.push({ pattern, handler })
    }
  }
  const fixture = {
    html: () => '<fixture>',
    sessionHtml: () => '<authenticated-session-fixture>',
    recordSend: () => { sent += 1 }
  }

  await installFixtureRoutes(context, fixture)

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
  assert.deepEqual(pageResponse, { status: 200, contentType: 'text/html; charset=utf-8', body: '<authenticated-session-fixture>' })
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

test('openPage requires positive session evidence beyond a non-root Facebook URL', async () => {
  let actualUrl = 'https://www.facebook.com/example'
  let hasSessionEvidence = false
  const page = {
    async goto(url) {
      if (String(url).endsWith('/me')) actualUrl = 'https://www.facebook.com/profile.php?id=123'
    },
    url: () => actualUrl,
    locator: selector => ({
      first() { return this },
      async isVisible() { return hasSessionEvidence && String(selector).includes('logout') }
    })
  }
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  browser.launch = async () => ({ pages: () => [page], newPage: async () => page })

  const withoutEvidence = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://www.facebook.com/example' })
  assert.equal(withoutEvidence.loggedIn, false)

  hasSessionEvidence = true
  const withEvidence = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://www.facebook.com/example' })
  assert.equal(withEvidence.loggedIn, true)
  assert.equal(withEvidence.dedicatedProfileSelected, true)
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
