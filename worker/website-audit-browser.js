const dns = require('node:dns/promises')
const net = require('node:net')
const { chromium } = require('playwright-core')
const { isPrivateHostname } = require('../lib/website-audit')

function classifyContactHref(href, text = '') {
  const value = String(href || '').trim()
  const label = `${text} ${value}`.toLowerCase()
  if (/^tel:/i.test(value)) return 'phone'
  if (/^mailto:/i.test(value)) return 'email'
  if (/wa\.me|whatsapp/i.test(label)) return 'whatsapp'
  if (/messenger\.com|facebook\.com\/messages/i.test(label)) return 'messenger'
  if (/book|booking|schedule|appointment|calendar|reserve/i.test(label)) return 'booking'
  if (/contact|support|help|get-in-touch|get_in_touch/i.test(label)) return 'contact_page'
  return null
}

function chooseContactClicks(methods = []) {
  const set = new Set(methods)
  if (['chat', 'phone', 'email', 'whatsapp', 'messenger', 'booking'].some(method => set.has(method))) return 0
  if (set.has('contact_form') || set.has('contact_page')) return 1
  return null
}

function detectChatProvider(resources = []) {
  const text = resources.join(' ').toLowerCase()
  const providers = [
    ['intercom', /intercom/],
    ['crisp', /crisp\.chat|client\.crisp/],
    ['tidio', /tidio/],
    ['hubspot', /hubspot|hs-scripts|conversations-embed/],
    ['drift', /drift\.com|driftt/],
    ['zendesk', /zendesk|zdassets|zopim/],
    ['tawk', /tawk\.to/],
    ['livechat', /livechatinc|livechat\.com/]
  ]
  return providers.find(([, pattern]) => pattern.test(text))?.[0] || 'website-chat'
}

function isSafeChatLauncher({ tagName, href } = {}) {
  const tag = String(tagName || '').toLowerCase()
  if (tag === 'a' || String(href || '').trim()) return false
  return tag === 'button' || tag === 'div' || tag === 'span'
}

function isPrivateAddress(address) {
  const raw = String(address || '').replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  if (net.isIPv4(raw)) return isPrivateHostname(raw)
  if (!net.isIPv6(raw)) return true
  const lower = raw.toLowerCase()
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
}

class WebsiteAuditBrowser {
  constructor({
    channel = 'chrome',
    executablePath = process.env.FACEBOOK_AUDIT_EXECUTABLE_PATH || '',
    headless = true,
    navigationTimeoutMs = 30000,
    pollIntervalMs = 350,
    browserType = chromium,
    now = () => new Date(),
    allowPrivateNetwork = false
  } = {}) {
    this.channel = channel
    this.executablePath = String(executablePath || '').trim()
    this.headless = headless
    this.navigationTimeoutMs = navigationTimeoutMs
    this.pollIntervalMs = pollIntervalMs
    this.browserType = browserType
    this.now = now
    this.allowPrivateNetwork = allowPrivateNetwork
    this.browser = null
    this.context = null
    this.page = null
    this.composer = null
    this.chatFrame = null
    this.auditId = ''
    this.sentMessage = ''
    this.baselineMessages = new Set()
    this.seenMessages = new Set()
    this.confirmedSentAtMs = null
    this.resolutionCache = new Map()
  }

  async _assertPublicHost(hostname) {
    if (this.allowPrivateNetwork) return
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
    if (isPrivateHostname(host)) throw Object.assign(new Error('The website resolved to a non-public network'), { code: 'website_private_network_blocked' })
    if (this.resolutionCache.has(host)) return this.resolutionCache.get(host)
    const pending = dns.lookup(host, { all: true, verbatim: true }).then(addresses => {
      if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
        throw Object.assign(new Error('The website resolved to a non-public network'), { code: 'website_private_network_blocked' })
      }
      return true
    })
    this.resolutionCache.set(host, pending)
    return pending
  }

  async launch() {
    if (this.browser) return this.browser
    const options = { headless: this.headless }
    if (this.executablePath) options.executablePath = this.executablePath
    else if (this.channel) options.channel = this.channel
    try {
      this.browser = await this.browserType.launch(options)
      return this.browser
    } catch {
      throw Object.assign(new Error('Website audit browser could not start'), {
        code: 'website_browser_launch_failed',
        publicMessage: 'Website audit browser could not start'
      })
    }
  }

  async _guardRequests(context) {
    await context.route('**/*', async route => {
      let url
      try { url = new URL(route.request().url()) } catch { return route.abort('blockedbyclient') }
      if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return route.abort('blockedbyclient')
      if (['data:', 'blob:'].includes(url.protocol)) return route.continue()
      try {
        await this._assertPublicHost(url.hostname)
        return route.continue()
      } catch {
        return route.abort('blockedbyclient')
      }
    })
  }

  async openWebsite(audit) {
    const target = new URL(audit.websiteUrl)
    await this._assertPublicHost(target.hostname)
    const browser = await this.launch()
    this.auditId = audit.auditId
    this.context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      locale: 'en-US',
      serviceWorkers: 'block'
    })
    this.context.setDefaultTimeout(8000)
    this.context.setDefaultNavigationTimeout(this.navigationTimeoutMs)
    await this._guardRequests(this.context)
    this.page = await this.context.newPage()
    const started = Date.now()
    let response
    try {
      response = await this.page.goto(audit.websiteUrl, { waitUntil: 'domcontentloaded' })
    } catch (error) {
      throw Object.assign(new Error('The submitted public website could not be opened'), {
        code: error.code === 'website_private_network_blocked' ? error.code : 'website_open_failed',
        publicMessage: 'The submitted public website could not be opened'
      })
    }
    const finalUrl = new URL(this.page.url())
    await this._assertPublicHost(finalUrl.hostname)
    await this.page.waitForTimeout(500)
    const status = response?.status?.() ?? null
    if (Number.isFinite(status) && status >= 500) {
      throw Object.assign(new Error('The website returned a server error'), {
        code: 'website_server_error',
        publicMessage: 'The website returned a server error'
      })
    }
    return {
      reachable: true,
      pageLoadMs: Math.max(0, Date.now() - started),
      finalUrl: finalUrl.toString(),
      httpStatus: status
    }
  }

  async _surface(page) {
    return page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const links = [...document.querySelectorAll('a[href],button')].filter(visible).map(element => ({
        href: element instanceof HTMLAnchorElement ? element.href : '',
        text: String(element.innerText || element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240)
      }))
      const forms = [...document.forms].filter(visible)
      return {
        links,
        formFieldCount: forms.reduce((total, form) => total + [...form.elements].filter(element => !['hidden', 'submit', 'button'].includes(String(element.type || '').toLowerCase())).length, 0),
        hasViewportMeta: Boolean(document.querySelector('meta[name="viewport"]')),
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 8,
        resources: performance.getEntriesByType('resource').map(entry => entry.name).slice(0, 500)
      }
    })
  }

  async _inspectContactPage(link) {
    if (!link?.href) return { formFieldCount: 0, methods: [] }
    let destination
    try { destination = new URL(link.href, this.page.url()) } catch { return { formFieldCount: 0, methods: [] } }
    if (destination.origin !== new URL(this.page.url()).origin) return { formFieldCount: 0, methods: [] }
    const page = await this.context.newPage()
    try {
      await page.goto(destination.toString(), { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(250)
      const surface = await this._surface(page)
      const methods = surface.links.map(item => classifyContactHref(item.href, item.text)).filter(Boolean)
      if (surface.formFieldCount) methods.push('contact_form')
      return { formFieldCount: surface.formFieldCount, methods }
    } catch {
      return { formFieldCount: 0, methods: [] }
    } finally {
      await page.close().catch(() => {})
    }
  }

  async _findComposer() {
    const selectors = [
      '[data-audit-chat-composer]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="chat" i]',
      '[contenteditable="true"][role="textbox"]',
      'input[placeholder*="message" i]'
    ]
    for (const frame of this.page.frames()) {
      for (const selector of selectors) {
        const candidates = frame.locator(selector)
        for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
          const candidate = candidates.nth(index)
          if (await candidate.isVisible().catch(() => false)) return { frame, composer: candidate }
        }
      }
    }
    return null
  }

  async _openChat() {
    let found = await this._findComposer()
    if (found) return found
    const candidates = [
      this.page.locator('[data-audit-chat-launcher]'),
      this.page.getByRole('button', { name: /chat|message us|live help|ask us|support/i }),
      this.page.locator('[aria-label*="chat" i]:not(a), [class*="chat-launcher" i]:not(a), [id*="chat-launcher" i]:not(a)')
    ]
    for (const group of candidates) {
      for (let index = 0; index < await group.count().catch(() => 0); index += 1) {
        const candidate = group.nth(index)
        if (!await candidate.isVisible().catch(() => false)) continue
        const descriptor = await candidate.evaluate(element => ({
          tagName: element.tagName,
          href: element instanceof HTMLAnchorElement ? element.href : ''
        })).catch(() => null)
        if (!isSafeChatLauncher(descriptor)) continue
        await candidate.click().catch(() => {})
        for (let attempt = 0; attempt < 20; attempt += 1) {
          found = await this._findComposer()
          if (found) return found
          await this.page.waitForTimeout(150)
        }
      }
    }
    return null
  }

  async inspectBuyerJourney(openState = {}) {
    if (!this.page) throw Object.assign(new Error('Website is not open'), { code: 'website_not_open' })
    const surface = await this._surface(this.page)
    const methods = surface.links.map(item => classifyContactHref(item.href, item.text)).filter(Boolean)
    if (surface.formFieldCount) methods.push('contact_form')
    const contactLink = surface.links.find(item => classifyContactHref(item.href, item.text) === 'contact_page')
    const contactPage = await this._inspectContactPage(contactLink)
    methods.push(...contactPage.methods)
    const chat = await this._openChat()
    if (chat) methods.push('chat')
    this.chatFrame = chat?.frame || null
    this.composer = chat?.composer || null
    const uniqueMethods = [...new Set(methods)]
    const frameUrls = this.page.frames().map(frame => frame.url())
    return {
      pageReachable: true,
      pageLoadMs: openState.pageLoadMs,
      finalUrl: openState.finalUrl || this.page.url(),
      contactMethods: uniqueMethods,
      contactClicks: chooseContactClicks(uniqueMethods),
      contactFormFieldCount: Math.max(surface.formFieldCount, contactPage.formFieldCount),
      bookingAvailable: uniqueMethods.includes('booking'),
      mobileFriendly: surface.hasViewportMeta && !surface.hasHorizontalOverflow,
      chatAvailable: Boolean(chat),
      chatProvider: chat ? detectChatProvider([...surface.resources, ...frameUrls]) : null
    }
  }

  async _collectMessages() {
    const frame = this.chatFrame || this.page
    if (!frame) return []
    return frame.locator('[data-audit-chat-message], [data-audit-message], [role="log"] [role="article"], [aria-live="polite"] [role="listitem"]').evaluateAll(nodes => {
      const occurrences = new Map()
      return nodes.map(node => {
        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()
        const rawId = node.getAttribute('data-audit-message-id') || node.getAttribute('data-message-id') || node.id || text
        const count = (occurrences.get(rawId) || 0) + 1
        occurrences.set(rawId, count)
        return { text, id: `${rawId}#${count}` }
      }).filter(item => item.text)
    }).catch(() => [])
  }

  async _stableBaseline() {
    let previous = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const entries = await this._collectMessages()
      const current = new Set(entries.map(item => item.id))
      if (previous && current.size === previous.size && [...current].every(id => previous.has(id))) {
        this.baselineMessages = current
        this.seenMessages = new Set(current)
        return true
      }
      previous = current
      await this.page.waitForTimeout(150)
    }
    return false
  }

  async _verifyNewOwnMessage(message, existing, timeoutMs = 6000) {
    const expected = String(message).replace(/\s+/g, ' ').trim()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const entries = await this._collectMessages()
      const match = entries.find(item => item.text === expected && !existing.has(item.id))
      if (match) return match
      await this.page.waitForTimeout(180)
    }
    return null
  }

  async sendMessage(message, { auditId } = {}) {
    if (!this.composer) throw Object.assign(new Error('No usable website chat composer was found'), { code: 'website_chat_unavailable' })
    if (this.confirmedSentAtMs !== null) throw Object.assign(new Error('The website audit question has already been sent'), { code: 'website_duplicate_send_blocked' })
    if (!await this._stableBaseline()) throw Object.assign(new Error('Website chat history did not stabilize'), { code: 'website_chat_baseline_unstable' })
    this.auditId = auditId || this.auditId
    this.sentMessage = String(message)
    const existing = new Set((await this._collectMessages()).map(item => item.id))
    await this.composer.fill(this.sentMessage)
    await this.composer.press('Enter')
    if (!await this._verifyNewOwnMessage(this.sentMessage, existing)) {
      throw Object.assign(new Error('Website chat send could not be confirmed'), { code: 'website_chat_send_unconfirmed' })
    }
    const sentAt = this.now()
    this.confirmedSentAtMs = sentAt.getTime()
    return { sentAt: sentAt.toISOString() }
  }

  async sendAuditDisclosure(message) {
    if (!this.composer || this.confirmedSentAtMs === null) throw Object.assign(new Error('Website chat is not ready for disclosure'), { code: 'website_disclosure_unavailable' })
    const disclosure = String(message || '').trim()
    const existing = new Set((await this._collectMessages()).map(item => item.id))
    await this.composer.fill(disclosure)
    await this.composer.press('Enter')
    if (!await this._verifyNewOwnMessage(disclosure, existing)) {
      throw Object.assign(new Error('Website audit disclosure could not be confirmed'), { code: 'website_disclosure_unconfirmed' })
    }
    return { sentAt: this.now().toISOString() }
  }

  async observeUntil({ deadlineAt, onReply }) {
    if (this.confirmedSentAtMs === null) throw Object.assign(new Error('Website chat send was not confirmed'), { code: 'website_chat_send_unconfirmed' })
    const deadlineMs = new Date(deadlineAt).getTime()
    while (Date.now() <= deadlineMs) {
      if (!this.page || this.page.isClosed()) throw Object.assign(new Error('Website closed during observation'), { code: 'website_closed' })
      const entries = await this._collectMessages()
      let stop = false
      let lastReplyAt = null
      for (const entry of entries) {
        if (this.seenMessages.has(entry.id)) continue
        this.seenMessages.add(entry.id)
        if (entry.text === this.sentMessage || entry.text.includes(this.auditId)) continue
        const receivedAt = this.now().toISOString()
        lastReplyAt = receivedAt
        const result = await onReply({ text: entry.text, receivedAt })
        stop ||= Boolean(result?.stop)
      }
      if (stop) return { observedUntil: lastReplyAt }
      await this.page.waitForTimeout(Math.min(this.pollIntervalMs, Math.max(1, deadlineMs - Date.now())))
    }
    return { observedUntil: new Date(Math.max(Date.now(), deadlineMs)).toISOString() }
  }

  async captureEvidence({ label }) {
    if (!this.page || this.page.isClosed()) return null
    return {
      type: 'screenshot',
      label,
      capturedAt: this.now().toISOString(),
      contentType: 'image/png',
      buffer: await this.page.screenshot({ fullPage: false })
    }
  }

  async closeAudit() {
    await this.context?.close().catch(() => {})
    this.context = null
    this.page = null
    this.composer = null
    this.chatFrame = null
    this.auditId = ''
    this.sentMessage = ''
    this.baselineMessages = new Set()
    this.seenMessages = new Set()
    this.confirmedSentAtMs = null
  }

  async shutdown() {
    await this.closeAudit()
    await this.browser?.close().catch(() => {})
    this.browser = null
  }
}

module.exports = {
  WebsiteAuditBrowser,
  chooseContactClicks,
  classifyContactHref,
  detectChatProvider,
  isSafeChatLauncher,
  isPrivateAddress
}
