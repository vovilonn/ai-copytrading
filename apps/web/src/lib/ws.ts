import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { MessageDto } from 'shared/dto.js'
import type { ClientToServerEvents, MessageNewPayload, ServerToClientEvents } from 'shared/ws-events.js'
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

    s.on('message.new', onMessageNew)

    return () => {
      s.off('message.new', onMessageNew)
      s.emit('channel.unsubscribe', channelId)
    }
  }, [channelId, queryClient])
}
