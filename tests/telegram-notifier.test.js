const test = require('node:test')
const assert = require('node:assert/strict')

const {
  safeTelegramErrorCode,
  sendTelegram
} = require('../lib/telegram-notifier')

test('telegram notifier reports missing configuration without exposing values', async () => {
  await assert.rejects(
    sendTelegram('test', { token: '   ', chatId: '', fetchImpl: async () => ({ ok: true }) }),
    error => error.code === 'telegram_not_configured' && !/token|chat id/i.test(error.message)
  )
})

test('telegram notifier preserves only safe HTTP and API error codes', async () => {
  const secret = '123456:super-secret-token'
  await assert.rejects(
    sendTelegram('test', {
      token: secret,
      chatId: '999999',
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error_code: 400, description: `chat not found ${secret}` })
      })
    }),
    error => {
      assert.equal(error.code, 'telegram_http_400_api_400')
      assert.doesNotMatch(error.message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    }
  )
})

test('telegram notifier converts fetch failures into a safe network code', async () => {
  const secret = '123456:super-secret-token'
  await assert.rejects(
    sendTelegram('test', {
      token: secret,
      chatId: '999999',
      fetchImpl: async () => { throw new Error(`request failed for bot${secret}`) }
    }),
    error => error.code === 'telegram_network_error' && !error.message.includes(secret)
  )
})

test('safe Telegram error codes reject arbitrary injected text', () => {
  assert.equal(safeTelegramErrorCode({ code: 'telegram_http_401_api_401' }), 'telegram_http_401_api_401')
  assert.equal(safeTelegramErrorCode({ code: 'secret value here' }), 'telegram_unknown_error')
})
