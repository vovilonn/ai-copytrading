import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { MessageDto } from 'shared/dto.js'
import type {
  ClientToServerEvents,
  MessageNewPayload,
  MessageUpdatedPayload,
  ServerToClientEvents,
} from 'shared/ws-events.js'
import { messagesQueryKey } from '../components/MessageTimeline.js'

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null

// Один сокет на всё приложение, лениво создаётся при первом использовании. Без явного URI
// socket.io-client коннектится на текущий origin — в деве это Vite (5173), чей прокси
// пробрасывает /socket.io на api (см. apps/web/vite.config.ts) вместе с кукой сессии.
function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  socket ??= io({ withCredentials: true })
  return socket
}

// Подписка компонента канала на реалтайм-события своего канала. Реконнект с бэк-оффом —
// дефолтное поведение socket.io-client, отдельно настраивать не нужно (бриф задачи 12).
export function useChannelStream(channelId: number): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const s = getSocket()
    s.emit('channel.subscribe', channelId)

    function onMessageNew(payload: MessageNewPayload): void {
      if (payload.channelId !== channelId) return

      queryClient.setQueryData<InfiniteData<MessageDto[]>>(messagesQueryKey(channelId), (old) => {
        if (!old) return old
        // Дубли исключены: сообщение с уже известным id (например, повторная доставка
        // после реконнекта) не вставляется второй раз.
        const alreadyKnown = old.pages.some((page) => page.some((m) => m.id === payload.message.id))
        if (alreadyKnown) return old

        const [firstPage, ...restPages] = old.pages
        return { ...old, pages: [[payload.message, ...(firstPage ?? [])], ...restPages] }
      })
    }

    // Правка Telegram-сообщения (текст/медиа/aiSummary) — заменяет узел с тем же message.id
    // НА МЕСТЕ, не создавая новый и не трогая порядок таймлайна. Если узел ещё не подгружен в
    // кэш (например, лежит на следующей ненагруженной странице useInfiniteQuery) — событие
    // безопасно игнорируется: подтянется актуальным текстом, когда страница загрузится обычным
    // GET-запросом.
    function onMessageUpdated(payload: MessageUpdatedPayload): void {
      if (payload.channelId !== channelId) return

      queryClient.setQueryData<InfiniteData<MessageDto[]>>(messagesQueryKey(channelId), (old) => {
        if (!old) return old
        const known = old.pages.some((page) => page.some((m) => m.id === payload.message.id))
        if (!known) return old

        return {
          ...old,
          pages: old.pages.map((page) =>
            page.map((m) => (m.id === payload.message.id ? payload.message : m)),
          ),
        }
      })
    }

    s.on('message.new', onMessageNew)
    s.on('message.updated', onMessageUpdated)

    return () => {
      s.off('message.new', onMessageNew)
      s.off('message.updated', onMessageUpdated)
      s.emit('channel.unsubscribe', channelId)
    }
  }, [channelId, queryClient])
}

const ACTIONS_THROTTLE_MS = 1000

/**
 * Реалтайм страницы Actions (задача 9): `action.new`/`action.skipped` летят в комнату
 * `channel:<id>` (realtime.gateway.ts — общей комнаты "все каналы" в шлюзе нет, трогать
 * apps/api в этой задаче нельзя), поэтому страница подписывается на комнаты ВСЕХ каналов
 * сразу — этого достаточно, чтобы не пропустить ни одного события.
 *
 * Payload события — узкий (см. p1-task8-report.md «Сомнения» №1: движок публикует
 * `{channelId, actionId, type, symbol, side, ...}`, а не собранный ActionRowDto), поэтому
 * вставлять его напрямую в кэш ненадёжно — вместо этого просто инвалидируем запрос
 * ['actions', ...] партиальным ключом (TanStack Query сам подхватит любой активный вариант
 * фильтров, включая ['actions', filters] текущей страницы) и даём TanStack Query перезапросить
 * актуальные строки с сервера. Троттлинг ~1/сек: пачка событий за секунду даёт максимум один
 * реальный рефетч (последний — по хвостовому таймеру, чтобы не потерять финальное состояние).
 */
export function useActionsStream(channelIds: readonly number[]): void {
  const queryClient = useQueryClient()
  const idsKey = channelIds.join(',')

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',').map(Number)
    if (ids.length === 0) return

    const s = getSocket()
    ids.forEach((id) => s.emit('channel.subscribe', id))

    let lastRun = 0
    let trailingTimer: ReturnType<typeof setTimeout> | undefined

    function invalidate(): void {
      lastRun = Date.now()
      void queryClient.invalidateQueries({ queryKey: ['actions'] })
    }

    function onActionEvent(): void {
      const elapsed = Date.now() - lastRun
      if (elapsed >= ACTIONS_THROTTLE_MS) {
        invalidate()
        return
      }
      if (trailingTimer) return
      trailingTimer = setTimeout(() => {
        trailingTimer = undefined
        invalidate()
      }, ACTIONS_THROTTLE_MS - elapsed)
    }

    s.on('action.new', onActionEvent)
    s.on('action.skipped', onActionEvent)

    return () => {
      s.off('action.new', onActionEvent)
      s.off('action.skipped', onActionEvent)
      ids.forEach((id) => s.emit('channel.unsubscribe', id))
      if (trailingTimer) clearTimeout(trailingTimer)
    }
  }, [idsKey, queryClient])
}
