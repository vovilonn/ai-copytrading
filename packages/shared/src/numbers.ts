/**
 * Число с разделителем тысяч (обычный пробел U+0020, неразрывный U+00A0, узкий
 * неразрывный U+202F) и десятичной частью через `.` или `,`. Порядок альтернатив
 * важен: сначала пробуем ветку с разделителями тысяч (иначе она бы не успевала
 * сработать — `\d+` из второй альтернативы уже "съел" бы первую тройку цифр).
 * Найдено и проверено на реальном дампе (`62 000$`, `1.5273-1.4735`, `0.0014856`).
 */
const NUM = /\d{1,3}(?:[\u0020\u00A0\u202F]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g

/** Снимает разделители тысяч и переводит десятичную запятую в точку перед parseFloat. */
export function toNum(s: string): number {
  return parseFloat(s.replace(/[\u0020\u00A0\u202F]/g, '').replace(',', '.'))
}

/** Извлекает из текста все числа (см. NUM) в порядке появления. */
export function parseNumbers(text: string): number[] {
  return (text.match(NUM) ?? []).map(toNum)
}

/**
 * NUMERIC из Postgres приходит строкой вида '500.00000000' — обрезает незначащие нули для
 * отображения (design/project/Admin.dc.html показывает '$500'/'10x', а не '$500.00000000').
 * Тот же приём, что и локальный formatNumeric в apps/api/src/channels/channels.service.ts
 * (не обобщался туда сознательно — минимальный риск диффа в уже протестированном файле);
 * здесь — общий хелпер для actions/positions (задача 8, apps/api/src/positions/positions.service.ts).
 */
export function formatDecimal(value: string): string {
  return String(Number(value))
}

/**
 * '+$327.60' / '-$24.00' — денежная сумма со знаком (design/project/Admin.dc.html:667 signedMoney,
 * apps/api/src/positions/positions.service.ts). Вынесено сюда (задача 10): точечный патч строки
 * Positions по live-тику mark price (apps/web/src/lib/ws.ts) обязан форматировать PnL ТЕМ ЖЕ
 * способом, что и обычный GET-ответ — иначе после первого тика строка визуально "дёрнется"
 * (смена числа знаков после запятой/разделителя), выдавая факт точечного патча.
 */
export function signedMoney(n: number): string {
  const sign = n >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function signedPct(n: number): string {
  const sign = n >= 0 ? '+' : '-'
  return `${sign}${Math.abs(n).toFixed(1)}%`
}

/** ROI = pnl/margin·100, '+6.2%' — 0%, если margin<=0 (см. computeRoi в positions.service.ts). */
export function computeRoi(pnl: number, margin: number): string {
  if (margin <= 0) return signedPct(0)
  return signedPct((pnl / margin) * 100)
}

/**
 * Разбивает "лесенку" целей, размеченную keycap-эмодзи (1️⃣, 2️⃣, 3️⃣…), на числа.
 * Keycap — это цифра + необязательный variation selector (U+FE0F) + enclosing
 * keycap (U+20E3); сплитим по этой последовательности, а не по самой цифре, чтобы
 * не резать десятичные дроби вида "82.3".
 * "1️⃣80.82️⃣82.33️⃣84" -> ["80.8", "82.3", "84"] -> [80.8, 82.3, 84]
 */
export function splitKeycaps(s: string): number[] {
  return s
    .split(/[0-9]\uFE0F?\u20E3/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(toNum)
}

/**
 * Win Rate (\u04244, task-2-brief.md): \u0434\u043E\u043B\u044F \u043F\u0440\u0438\u0431\u044B\u043B\u044C\u043D\u044B\u0445 \u0417\u0410\u041A\u0420\u042B\u0422\u042B\u0425 \u0441\u0434\u0435\u043B\u043E\u043A \u043A\u0430\u043D\u0430\u043B\u0430. `closedTrades` \u2014
 * count(status='closed') (cancelled \u2014 \u043D\u0435\u0438\u0441\u043F\u043E\u043B\u043D\u0438\u0432\u0448\u0438\u0435\u0441\u044F \u043B\u0438\u043C\u0438\u0442\u043A\u0438, \u041D\u0415 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442, \u0432 \u0437\u043D\u0430\u043C\u0435\u043D\u0430\u0442\u0435\u043B\u044C \u043D\u0435
 * \u0432\u0445\u043E\u0434\u044F\u0442); `wins` \u2014 count(is_win) \u0441\u0440\u0435\u0434\u0438 \u043D\u0438\u0445. closedTrades=0 (\u043D\u0438 \u043E\u0434\u043D\u043E\u0439 \u0437\u0430\u043A\u0440\u044B\u0442\u043E\u0439 \u0441\u0434\u0435\u043B\u043A\u0438 \u0435\u0449\u0451 \u043D\u0435\u0442) \u2014
 * design/project/Admin.dc.html:161 \u043F\u0443\u0441\u0442\u043E\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 '\u2014', \u0430 \u043D\u0435 '0%' (\u043D\u0435 \u043F\u0443\u0442\u0430\u0442\u044C "\u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445" \u0441
 * "0% \u043F\u043E\u0431\u0435\u0434"). \u041E\u0431\u0449\u0438\u0439 \u0445\u0435\u043B\u043F\u0435\u0440: \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0438 apps/api/src/channels/stats.service.ts (REST-\u043E\u0442\u0432\u0435\u0442),
 * \u0438 apps/engine/src/state/trades.ts (payload \u0440\u0435\u0430\u043B\u0442\u0430\u0439\u043C-\u0441\u043E\u0431\u044B\u0442\u0438\u044F 'channel.stats') \u2014 \u043E\u0434\u043D\u0430 \u0444\u043E\u0440\u043C\u0443\u043B\u0430
 * \u043E\u043A\u0440\u0443\u0433\u043B\u0435\u043D\u0438\u044F, \u043D\u0435 \u0434\u0443\u0431\u043B\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0432 \u0434\u0432\u0443\u0445 \u0440\u0430\u043D\u0442\u0430\u0439\u043C\u0430\u0445.
 */
export function formatWinRate(closedTrades: number, wins: number): string {
  if (closedTrades <= 0) return '\u2014'
  return `${Math.round((wins / closedTrades) * 100)}%`
}
