const test = require('node:test')
const assert = require('node:assert/strict')

const {
  chooseContactClicks,
  classifyContactHref,
  detectChatProvider,
  isSafeChatLauncher
} = require('../worker/website-audit-browser')

test('website browser classifies useful public contact destinations', () => {
  assert.equal(classifyContactHref('tel:+15550100', 'Call us'), 'phone')
  assert.equal(classifyContactHref('mailto:sales@example.com', 'Email sales'), 'email')
  assert.equal(classifyContactHref('https://wa.me/15550100', 'WhatsApp'), 'whatsapp')
  assert.equal(classifyContactHref('/book-a-call', 'Book a call'), 'booking')
  assert.equal(classifyContactHref('/contact', 'Contact'), 'contact_page')
  assert.equal(classifyContactHref('/about', 'About'), null)
})

test('contact friction counts immediate help before contact-page navigation', () => {
  assert.equal(chooseContactClicks(['chat', 'phone']), 0)
  assert.equal(chooseContactClicks(['contact_page']), 1)
  assert.equal(chooseContactClicks([]), null)
})

test('chat provider detection is evidence based and otherwise stays generic', () => {
  assert.equal(detectChatProvider(['https://widget.intercom.io/widget/abc']), 'intercom')
  assert.equal(detectChatProvider(['https://client.crisp.chat/l.js']), 'crisp')
  assert.equal(detectChatProvider(['https://example.com/support-frame']), 'website-chat')
})

test('website chat discovery never clicks navigation links', () => {
  assert.equal(isSafeChatLauncher({ tagName: 'BUTTON', href: '' }), true)
  assert.equal(isSafeChatLauncher({ tagName: 'DIV', href: '' }), true)
  assert.equal(isSafeChatLauncher({ tagName: 'A', href: 'https://wa.me/15550100' }), false)
  assert.equal(isSafeChatLauncher({ tagName: 'A', href: '#chat' }), false)
})
