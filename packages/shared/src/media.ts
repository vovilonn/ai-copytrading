// Единая точка правды для пути раздачи медиа-файлов. HTTP API смонтирован под префиксом
// /api (apps/api/src/app.ts, setGlobalPrefix('api') — задача 12c: без этого прокси Vite
// перехватывает /channels/:id как HTTP-роут раньше SPA-роута, и F5 на странице канала отдаёт
// сырой JSON вместо приложения). Оба продюсера ссылок на медиа — REST-ответ API
// (apps/api/src/channels/channels.service.ts) и websocket-payload 'message.new' (apps/tg-ingest)
// — обязаны формировать один и тот же префикс, поэтому вынесено сюда, а не задублировано.
export function mediaUrl(mediaId: string): string {
  return `/api/media/${mediaId}`
}
