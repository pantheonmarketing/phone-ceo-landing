const DEFAULT_TIMEOUT_MS = 10000

function telegramError(code) {
  const error = new Error('Private notification could not be delivered')
  error.code = code
  return error
}

function safeTelegramErrorCode(error) {
  const code = String(error?.code || '')
  return /^telegram_(?:not_configured|network_error|http_\d{3}(?:_api_\d+)?)$/.test(code)
    ? code
    : 'telegram_unknown_error'
}

async function sendTelegram(text, {
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const cleanToken = String(token || '').trim()
  const cleanChatId = String(chatId || '').trim()
  if (!cleanToken || !cleanChatId) throw telegramError('telegram_not_configured')
  if (typeof fetchImpl !== 'function') throw telegramError('telegram_network_error')

  let response
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cleanChatId,
        text: String(text || ''),
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    })
  } catch {
    throw telegramError('telegram_network_error')
  }

  if (!response.ok) {
    let apiCode = null
    try {
      const body = await response.json()
      if (Number.isInteger(body?.error_code)) apiCode = body.error_code
    } catch {}
    const status = Number.isInteger(response.status) ? response.status : 0
    const code = `telegram_http_${status}${apiCode === null ? '' : `_api_${apiCode}`}`
    throw telegramError(code)
  }
  return true
}

module.exports = {
  safeTelegramErrorCode,
  sendTelegram
}
