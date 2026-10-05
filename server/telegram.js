export function createTelegram({ token, chatId, fetchFn }) {
  async function call(method, payload) {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      // Токен в помилку не потрапляє: лише метод і опис від Telegram
      throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    }
    return data.result;
  }

  return {
    chatId: String(chatId),
    sendOrder: (text, replyMarkup) => call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }),
    editMessage: ({ messageId, text, entities, replyMarkup }) => call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      entities,
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }),
    setWebhook: (url, secretToken) => call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['callback_query'],
    }),
  };
}
