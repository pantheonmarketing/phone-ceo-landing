const { chromium } = require('playwright-core')

function normalizeEntry(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function selectNewConversationEntries({ baseline, current, sentMessage, auditId, seen }) {
  const sent = normalizeEntry(sentMessage)
  const id = String(auditId || '').toLowerCase()
  const found = []
  for (const raw of current) {
    const entry = normalizeEntry(raw)
    if (!entry || entry.length > 3000 || baseline.has(entry) || seen.has(entry)) continue
    if (entry === sent || (id && entry.toLowerCase().includes(id))) continue
    seen.add(entry)
    found.push(entry)
  }
  return found
}

class FacebookMessengerBrowser {
  constructor({
    profileDirectory,
    channel = 'chrome',
    headless = false,
    navigationTimeoutMs = 30000,
    pollIntervalMs = 350,
    now = () => new Date()
  } = {}) {
    if (!profileDirectory) throw new Error('FACEBOOK_AUDIT_PROFILE_DIR is required')
    this.profileDirectory = profileDirectory
    this.channel = channel
    this.headless = headless
    this.navigationTimeoutMs = navigationTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.now = now
    this.context = null
    this.page = null
    this.composer = null
    this.baselineEntries = new Set()
    this.sentMessage = ''
    this.auditId = ''
  }

  async launch() {
    if (this.context) return this.context
    try {
      this.context = await chromium.launchPersistentContext(this.profileDirectory, {
        channel: this.channel,
        headless: this.headless,
        viewport: this.headless ? { width: 1440, height: 960 } : null,
        locale: 'en-US'
      })
    } catch {
      throw Object.assign(new Error('Dedicated audit browser could not start. Confirm it is installed and the audit profile is not open elsewhere.'), {
        code: 'browser_launch_failed',
        publicMessage: 'Dedicated audit browser could not start'
      })
    }
    this.context.setDefaultTimeout(10000)
    this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs)
    return this.context
  }

  async openForLogin() {
    const context = await this.launch()
    this.page = context.pages()[0] || await context.newPage()
    await this.page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' })
    return this.page
  }

  async openPage(audit) {
    const context = await this.launch()
    this.auditId = audit.auditId
    this.page = await context.newPage()
    try {
      await this.page.goto(audit.pageUrl, { waitUntil: 'domcontentloaded' })
    } catch {
      throw Object.assign(new Error('The submitted Facebook Page could not be opened'), {
        code: 'facebook_page_open_failed',
        publicMessage: 'The submitted Facebook Page could not be opened'
      })
    }
    await this.page.waitForTimeout(750)

    let navigatedUrl
    try {
      navigatedUrl = new URL(this.page.url())
    } catch {
      return { loggedIn: false, dedicatedProfileSelected: true, reason: 'facebook_page_host_unverified' }
    }
    const acceptedHosts = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'www.fb.com'])
    if (navigatedUrl.protocol !== 'https:' || !acceptedHosts.has(navigatedUrl.hostname.toLowerCase())) {
      return { loggedIn: false, dedicatedProfileSelected: true, reason: 'facebook_page_host_unverified' }
    }
    const loginUrl = /\/(login|checkpoint)(?:\/|\?|$)/i.test(navigatedUrl.pathname)
    const loginField = await this.page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false)
    const accountEvidence = await this.page.locator('[aria-label*="your profile" i], [aria-label*="account" i], a[href*="/me"], [data-pagelet="ProfileActions"]').first().isVisible().catch(() => false)
    return { loggedIn: !(loginUrl || loginField) && accountEvidence, dedicatedProfileSelected: true }
  }

  async _findComposer(page = this.page) {
    const selectors = [
      '[data-audit-composer]',
      'textarea[placeholder*="message" i]',
      '[contenteditable="true"][role="textbox"]',
      '[role="textbox"][aria-label*="message" i]'
    ]
    for (const selector of selectors) {
      const candidates = page.locator(selector)
      for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
        const candidate = candidates.nth(index)
        if (await candidate.isVisible().catch(() => false)) return candidate
      }
    }
    return null
  }

  async _collectEntries(page = this.page) {
    return page.locator('[data-audit-message], [role="main"] [role="row"], [aria-label*="Messages" i] [role="row"]').evaluateAll(nodes => {
      const unique = new Set()
      for (const node of nodes) {
        const value = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
        if (value) unique.add(value)
      }
      return [...unique]
    }).catch(() => [])
  }

  async openMessenger() {
    this.composer = await this._findComposer()
    if (!this.composer) {
      const candidates = [
        this.page.locator('[data-audit-action="message"]'),
        this.page.getByRole('button', { name: /^(message|send message|contact us)$/i }),
        this.page.getByRole('link', { name: /^(message|send message|contact us)$/i }),
        this.page.locator('a[href*="messenger.com/t/"], a[href*="/messages/t/"]')
      ]
      let clicked = false
      const pagesBefore = new Set(this.context.pages())
      for (const group of candidates) {
        const count = await group.count().catch(() => 0)
        for (let index = 0; index < count; index += 1) {
          const candidate = group.nth(index)
          if (!await candidate.isVisible().catch(() => false)) continue
          await candidate.click()
          clicked = true
          break
        }
        if (clicked) break
      }
      if (!clicked) return { reachable: false }

      const expiresAt = Date.now() + 10000
      while (Date.now() < expiresAt) {
        const popup = this.context.pages().find(page => !pagesBefore.has(page))
        if (popup) this.page = popup
        this.composer = await this._findComposer(this.page)
        if (this.composer) break
        await this.page.waitForTimeout(250)
      }
    }

    if (!this.composer) return { reachable: false }
    this.baselineEntries = new Set((await this._collectEntries()).map(normalizeEntry))
    return { reachable: true }
  }

  async sendMessage(message, { auditId } = {}) {
    if (!this.composer) throw Object.assign(new Error('Messenger composer is not ready'), { code: 'messenger_composer_missing' })
    this.sentMessage = String(message)
    this.auditId = auditId || this.auditId
    await this.composer.fill(this.sentMessage)
    await this.composer.press('Enter')
    const verificationDeadline = Date.now() + 6000
    let verified = false
    while (Date.now() < verificationDeadline) {
      const entries = await this._collectEntries()
      if (entries.some(entry => normalizeEntry(entry).toLowerCase().includes(String(this.auditId).toLowerCase()))) {
        verified = true
        break
      }
      await this.page.waitForTimeout(200)
    }
    if (!verified) throw Object.assign(new Error('The sent message could not be verified in the conversation'), { code: 'send_not_confirmed' })
    return { sentAt: this.now().toISOString() }
  }

  async observeUntil({ deadlineAt, onReply }) {
    const deadlineMs = new Date(deadlineAt).getTime()
    const seen = new Set()
    while (Date.now() <= deadlineMs) {
      if (!this.page || this.page.isClosed()) throw Object.assign(new Error('Messenger page closed during observation'), { code: 'messenger_closed' })
      const entries = selectNewConversationEntries({
        baseline: this.baselineEntries,
        current: await this._collectEntries(),
        sentMessage: this.sentMessage,
        auditId: this.auditId,
        seen
      })
      for (const text of entries) {
        const receivedAt = new Date().toISOString()
        const result = await onReply({ text, receivedAt })
        if (result?.stop) return { observedUntil: receivedAt }
      }
      await this.page.waitForTimeout(Math.min(this.pollIntervalMs, Math.max(1, deadlineMs - Date.now())))
    }
    return { observedUntil: new Date(Math.max(Date.now(), deadlineMs)).toISOString() }
  }

  async captureEvidence({ label }) {
    if (!this.page || this.page.isClosed()) return null
    return {
      type: 'screenshot',
      label,
      capturedAt: new Date().toISOString(),
      contentType: 'image/png',
      buffer: await this.page.screenshot({ fullPage: false })
    }
  }

  async closeAudit() {
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {})
    this.page = null
    this.composer = null
  }

  async shutdown() {
    if (this.context) await this.context.close().catch(() => {})
    this.context = null
  }
}

module.exports = { FacebookMessengerBrowser, normalizeEntry, selectNewConversationEntries }
