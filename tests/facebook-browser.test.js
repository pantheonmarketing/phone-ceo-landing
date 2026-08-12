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
    return [{ text: 'Audit ID: FBA-ABCDEF12', id: 'sent-1', timestampMs: Date.now() }]
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

test('openPage fails closed when Facebook redirects to a different Page', async () => {
  const page = {
    async goto() {},
    async waitForTimeout() {},
    url: () => 'https://www.facebook.com/another-page',
    locator: () => ({
      first() { return this },
      async isVisible() { return false }
    })
  }
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  browser.launch = async () => ({ pages: () => [page], newPage: async () => page })

  const result = await browser.openPage({ auditId: 'FBA-ABCDEF12', pageUrl: 'https://www.facebook.com/example' })

  assert.equal(result.loggedIn, false)
  assert.equal(result.reason, 'facebook_page_identity_unverified')
})

test('openPage requires positive session evidence beyond a non-root Facebook URL', async () => {
  let actualUrl = 'https://www.facebook.com/example'
  let hasSessionEvidence = false
  const page = {
    async goto(url) {
      actualUrl = String(url).endsWith('/me')
        ? 'https://www.facebook.com/profile.php?id=123'
        : 'https://www.facebook.com/example'
    },
    async waitForTimeout() {},
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

test('sendMessage stabilizes the conversation baseline before sending', async () => {
  let reads = 0
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  browser.auditId = 'FBA-ABCDEF12'
  browser.composer = {
    async fill() {},
    async press() {}
  }
  browser.page = { waitForTimeout: async () => {} }
  const entry = (text, timestampMs = null) => ({ text, id: text, timestampMs })
  browser._collectEntries = async () => {
    reads += 1
    if (reads < 3) return reads === 1 ? [entry('Conversation ready')] : [entry('Conversation ready'), entry('Late loaded history')]
    if (reads === 3) return [entry('Conversation ready'), entry('Late loaded history')]
    return [entry('Conversation ready'), entry('Late loaded history'), entry('Audit ID: FBA-ABCDEF12', Date.now())]
  }

  await browser.sendMessage('Audit question', { auditId: 'FBA-ABCDEF12' })

  assert.equal(browser.baselineEntries.has('Late loaded history'), true)
  assert.deepEqual(selectNewConversationEntries({
    baseline: browser.baselineEntries,
    current: ['Late loaded history', 'A new customer reply'],
    sentMessage: 'Audit question',
    auditId: 'FBA-ABCDEF12',
    seen: new Set()
  }), ['A new customer reply'])
})

test('closed browser contexts are cleared before the next launch', async () => {
  let launches = 0
  let closeHandler
  const contexts = [
    {
      once(event, handler) { assert.equal(event, 'close'); closeHandler = handler },
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {}
    },
    {
      once() {},
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {}
    }
  ]
  const browser = new FacebookMessengerBrowser({
    profileDirectory: 'test-profile',
    browserType: {
      async launchPersistentContext() { return contexts[launches++] }
    }
  })

  const first = await browser.launch()
  closeHandler()
  const second = await browser.launch()

  assert.notEqual(first, second)
  assert.equal(launches, 2)
})

test('launch uses a configured executable instead of an incompatible browser channel', async () => {
  let launchDirectory
  let launchOptions
  const context = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {}
  }
  const browser = new FacebookMessengerBrowser({
    profileDirectory: 'test-profile',
    channel: 'chrome',
    executablePath: '/opt/chromium/chrome',
    browserType: {
      async launchPersistentContext(directory, options) {
        launchDirectory = directory
        launchOptions = options
        return context
      }
    }
  })

  await browser.launch()

  assert.equal(launchDirectory, 'test-profile')
  assert.equal(launchOptions.executablePath, '/opt/chromium/chrome')
  assert.equal('channel' in launchOptions, false)
})

test('_collectEntries preserves missing timestamps and propagates collection failures', async () => {
  const node = {
    innerText: 'Unverifiable reply',
    textContent: 'Unverifiable reply',
    getAttribute(name) {
      return name === 'data-message-id' ? 'reply-1' : null
    },
    matches() { return false },
    querySelector() { return null }
  }
  const browser = new FacebookMessengerBrowser({ profileDirectory: 'test-profile' })
  const page = { locator: () => ({ evaluateAll: async callback => callback([node]) }) }

  const entries = await browser._collectEntries(page)
  assert.deepEqual(entries, [{ text: 'Unverifiable reply', id: 'reply-1', timestampMs: null }])
  assert.throws(() => selectNewConversationEntries({
    baseline: new Set(),
    current: entries,
    sentMessage: 'Audit question',
    auditId: 'FBA-ABCDEF12',
    seen: new Set(),
    minTimestampMs: 1000
  }), /reliable post-send evidence/)

  const brokenPage = { locator: () => ({ evaluateAll: async () => { throw new Error('detached') } }) }
  await assert.rejects(browser._collectEntries(brokenPage), error => error.code === 'conversation_collection_failed')
})

test('selectNewConversationEntries fails closed without post-send timestamps', () => {
  assert.throws(() => selectNewConversationEntries({
    baseline: new Set(),
    current: [
      { text: 'Delayed history', id: 'history-2', timestampMs: 900 },
      { text: 'Useful reply', id: 'reply-1', timestampMs: 1100 },
      'Unverifiable reply'
    ],
    sentMessage: 'Audit question',
    auditId: 'FBA-ABCDEF12',
    seen: new Set(),
    minTimestampMs: 1000
  }), /reliable post-send evidence/)

  assert.deepEqual(selectNewConversationEntries({
    baseline: new Set(),
    current: [
      { text: 'Delayed history', id: 'history-2', timestampMs: 900 },
      { text: 'Useful reply', id: 'reply-1', timestampMs: 1100 }
    ],
    sentMessage: 'Audit question',
    auditId: 'FBA-ABCDEF12',
    seen: new Set(),
    minTimestampMs: 1000
  }), ['Useful reply'])
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
