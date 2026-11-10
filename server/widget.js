// Пробний віджет Telegram (Bot API 10.4, sendWidget): один самодостатній HTML без мережі, до 4 КБ після стиснення.
// Показує те саме зведення, що й /digest, і кнопку копіювання - щоб перевірити, чи формат працює на пристроях менеджерів.
const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// digestHtml — текст зведення в HTML Telegram (уже екранований, лише теги <b>)
export function buildDigestWidget(digestHtml) {
  const plain = digestHtml.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>body{margin:0;padding:12px 14px max(14px,env(safe-area-inset-bottom));line-height:1.45}',
    'button{margin-top:10px;width:100%;padding:10px;border:0;border-radius:10px;font:inherit;',
    'background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}</style>',
    `<div>${digestHtml.split('\n').join('<br>')}</div>`,
    `<button id="c" data-text="${escapeAttr(plain)}">Скопіювати зведення</button>`,
    '<script>document.getElementById("c").addEventListener("click",function(e){',
    'if(window.TelegramWidget&&TelegramWidget.copyText)TelegramWidget.copyText(e.currentTarget.dataset.text)})</script>',
  ].join('');
}
