import type { InfiniteData } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Side } from 'shared/domain.js'
import type { ChannelDto, MessageDto, PositionDto } from 'shared/dto.js'
import { computeRoi, formatDecimal, signedMoney } from 'shared/numbers.js'
import type {
  ChannelStatsPayload,
  ClientToServerEvents,
  MessageNewPayload,
  MessageUpdatedPayload,
  PositionUpsertPayload,
  ServerToClientEvents,
} from 'shared/ws-events.js'
import { messagesQueryKey } from '../components/MessageTimeline.js'
import { POSITIONS_LIST_KEY, positionsStatsQueryKey } from '../routes/positions.js'

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

// Бриф задачи 10: карточки статистики Positions обновляются РЕЖЕ строк таблицы (раз в 2-3 сек) —
// уже не 1/сек, как action.new выше: тикеры mark price летят за КАЖДУЮ открытую позицию, суммарно
// заметно чаще одиночных действий Actions.
const POSITIONS_STATS_THROTTLE_MS = 2500
const POSITIONS_STRUCTURAL_THROTTLE_MS = 2500

/** Trailing-throttle: первый вызов после паузы — сразу, дальше не чаще period мс, но всегда
 *  выполняется финальный отложенный вызов (та же логика, что инлайн в useActionsStream выше,
 *  вынесена в хелпер — usePositionsStream нужны ДВЕ независимые троттлинг-очереди сразу). */
function createTrailingThrottle(fn: () => void, periodMs: number): { trigger: () => void; cancel: () => void } {
  let lastRun = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function run(): void {
    lastRun = Date.now()
    fn()
  }

  return {
    trigger(): void {
      const elapsed = Date.now() - lastRun
      if (elapsed >= periodMs) {
        run()
        return
      }
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, periodMs - elapsed)
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** (mark−avg)·size для long, (avg−mark)·size для short — тот же расчёт, что apps/engine/src/
 *  market-data/pnl.ts (Decimal), здесь — plain number: точности double достаточно на уровне
 *  отображения (та же логика, что и pnlOf/notionalOf в apps/api/src/positions/positions.service.ts,
 *  которые тоже считают агрегаты на Number, не Decimal). */
function computeLivePnl(side: Side, size: string, avgPrice: string | null, markPrice: string | null): number {
  const avg = avgPrice !== null ? Number(avgPrice) : 0
  const mark = markPrice !== null ? Number(markPrice) : avg
  const sizeNum = Number(size)
  return side === 'long' ? (mark - avg) * sizeNum : (avg - mark) * sizeNum
}

/**
 * position.upsert (apps/engine: pipeline.ts emitPositionUpsert И market-data/apply-tick.ts —
 * ОБА пишут одинаковый ПОЛНЫЙ снимок строки positions на момент публикации, не дельту) —
 * поэтому каждое поле payload'а можно применить напрямую, форматируя теми же функциями
 * (formatDecimal/signedMoney/computeRoi), что и обычный GET /api/positions
 * (positions.service.ts) — точечно пропатченная строка визуально неотличима от свежерасчитанной.
 * tp/liq/marginMode/source/tradeRef payload не несёт (см. shared/ws-events.ts) — берутся из
 * текущей строки как есть (spread `...current`).
 */
function patchPositionRow(current: PositionDto, payload: PositionUpsertPayload): PositionDto {
  const side = payload.side ?? current.side
  const mark =
    payload.markPrice !== null
      ? formatDecimal(payload.markPrice)
      : payload.avgPrice !== null
        ? formatDecimal(payload.avgPrice)
        : current.mark
  const entry = payload.avgPrice !== null ? formatDecimal(payload.avgPrice) : current.entry
  const leverage = `${payload.leverage !== null ? formatDecimal(payload.leverage) : '0'}x`
  const sl = payload.stopLoss !== null ? formatDecimal(payload.stopLoss) : null

  const pnl = computeLivePnl(side, payload.size, payload.avgPrice, payload.markPrice)
  const notional = Math.abs(Number(payload.size)) * Number(mark)
  const levNum = payload.leverage !== null ? Number(payload.leverage) : 0
  const margin = levNum > 0 ? notional / levNum : notional

  return {
    ...current,
    side,
    size: formatDecimal(payload.size),
    entry,
    mark,
    leverage,
    sl,
    unrealisedPnl: signedMoney(pnl),
    roi: computeRoi(pnl, margin),
  }
}

/**
 * Реалтайм страницы Positions (задача 10): `position.upsert` летит В ТУ ЖЕ комнату channel:<id>,
 * что и action.new (см. useActionsStream) — тот же приём подписки на комнаты ВСЕХ каналов сразу.
 *
 * СТРАТЕГИЯ (обоснование, task-10-brief.md явно предлагает выбрать): точечный патч строки, а
 * НЕ инвалидация всего списка. Причина — частота: mark price тикает до ~1 раза в секунду НА
 * КАЖДУЮ открытую позицию (движок троттлит именно так, apps/engine/src/market-data/tickers-feed.ts),
 * то есть при N открытых позициях — до N событий/сек постоянно, пока рынок жив. Инвалидация
 * всего списка на каждое такое событие означала бы до N лишних GET /api/positions в секунду
 * (то же самое, что просто polling, только через WS) — тогда как payload уже содержит всё
 * нужное, чтобы пересчитать mark/PnL/ROI строки на клиенте без похода на сервер. Actions,
 * для сравнения, троттлит через инвалидацию ровно потому, что там события редкие и дискретные
 * (реальные торговые сигналы, не рыночный шум), payload не несёт готовой строки, а сам список
 * short — инвалидация раз в секунду там дёшева и достаточна.
 *
 * Точечный патч работает, только если строка УЖЕ есть в закэшированном списке (совпадение по
 * channelId+symbol). Если нет — тик по позиции, которую страница ещё не видела (новая открытая
 * позиция, или тик прилетел раньше, чем card успела подгрузить свежий список), или каналы —
 * догоняем обычным (троттлленным, раз в 2.5с) invalidateQueries. Стат-карточки — своя,
 * независимая троттлинг-очередь той же частоты (2.5с, бриф просит "реже").
 */
export function usePositionsStream(channelIds: readonly number[]): void {
  const queryClient = useQueryClient()
  const idsKey = channelIds.join(',')

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',').map(Number)
    if (ids.length === 0) return

    const s = getSocket()
    ids.forEach((id) => s.emit('channel.subscribe', id))

    const statsThrottle = createTrailingThrottle(
      () => void queryClient.invalidateQueries({ queryKey: positionsStatsQueryKey() }),
      POSITIONS_STATS_THROTTLE_MS,
    )
    const listFallback = createTrailingThrottle(
      () => void queryClient.invalidateQueries({ queryKey: [POSITIONS_LIST_KEY], exact: false }),
      POSITIONS_STRUCTURAL_THROTTLE_MS,
    )

    function onPositionUpsert(payload: PositionUpsertPayload): void {
      let matched = false

      queryClient.setQueriesData<PositionDto[]>({ queryKey: [POSITIONS_LIST_KEY], exact: false }, (old) => {
        if (!old) return old
        const idx = old.findIndex((p) => p.channelId === payload.channelId && p.symbol === payload.symbol)
        if (idx === -1) return old
        matched = true

        // size=0 — позиция закрылась: GET /api/positions её больше не вернёт (size<>0 —
        // фильтр backend'а, positions.service.ts), убираем строку сразу, не дожидаясь рефетча.
        if (Number(payload.size) === 0) {
          return old.filter((_, i) => i !== idx)
        }

        const current = old[idx]
        if (!current) return old
        const copy = old.slice()
        copy[idx] = patchPositionRow(current, payload)
        return copy
      })

      if (!matched) listFallback.trigger()
      statsThrottle.trigger()
    }

    s.on('position.upsert', onPositionUpsert)

    return () => {
      s.off('position.upsert', onPositionUpsert)
      ids.forEach((id) => s.emit('channel.unsubscribe', id))
      statsThrottle.cancel()
      listFallback.cancel()
    }
  }, [idsKey, queryClient])
}

/**
 * Win Rate в реалтайме (задача Ф4, task-2-brief.md п.4): `channel.stats` летит в комнату
 * `channel:<id>` при КАЖДОМ закрытии сделки этого канала (apps/engine/src/state/trades.ts::
 * closeTrade) — точечно патчим winRate и в списке каналов (['channels']), и в шапке экрана
 * канала (['channel', id]), не дожидаясь рефетча. Тот же приём подписки на комнаты ВСЕХ каналов
 * сразу, что и useActionsStream/usePositionsStream выше; событие редкое и дискретное (сделка
 * закрывается не чаще, чем открывается), поэтому точечный патч без троттлинга — не polling.
 */
export function useChannelStatsStream(channelIds: readonly number[]): void {
  const queryClient = useQueryClient()
  const idsKey = channelIds.join(',')

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',').map(Number)
    if (ids.length === 0) return

    const s = getSocket()
    ids.forEach((id) => s.emit('channel.subscribe', id))

    function onChannelStats(payload: ChannelStatsPayload): void {
      queryClient.setQueryData<ChannelDto[]>(['channels'], (old) =>
        old?.map((c) => (c.id === payload.channelId ? { ...c, winRate: payload.winRate } : c)),
      )
      queryClient.setQueryData<ChannelDto>(['channel', payload.channelId], (old) =>
        old ? { ...old, winRate: payload.winRate } : old,
      )
    }

    s.on('channel.stats', onChannelStats)

    return () => {
      s.off('channel.stats', onChannelStats)
      ids.forEach((id) => s.emit('channel.unsubscribe', id))
    }
  }, [idsKey, queryClient])
}
