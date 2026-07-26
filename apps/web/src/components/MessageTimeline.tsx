import { type QueryKey } from '@tanstack/react-query'
import { ArrowUpRight, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { actionIconColor, actionSummary } from 'shared/action-meta.js'
import { isMessagePending, type MessageActionDto, type MessageDto } from 'shared/dto.js'
import { skipReasonLabel } from 'shared/skip-reason.js'
import { getActionIcon, isNeedsReviewReason, normalizeTradeRef } from '../lib/action-display.js'
import { apiFetch } from '../lib/api.js'
import { useCursorList } from '../lib/use-cursor-list.js'
import { useChannelStream } from '../lib/ws.js'
import { LoadMore } from './LoadMore.js'

const PAGE_SIZE = 50

// Общий ключ инвалидации/патча кэша — используется и здесь (useInfiniteQuery), и в
// lib/ws.ts (useChannelStream вставляет message.new в этот же кэш), поэтому вынесен
// в один экспорт вместо дублирования литерала массива в двух файлах.
export function messagesQueryKey(channelId: number): QueryKey {
  return ['channel', channelId, 'messages']
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso))
}

async function fetchMessages(channelId: number, before?: number): Promise<MessageDto[]> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) params.set('before', String(before))
  return apiFetch<MessageDto[]>(`/channels/${channelId}/messages?${params.toString()}`)
}

interface MessageTimelineProps {
  channelId: number
}

// Таймлайн сообщений канала — геометрия 1 к 1 из design/project/Admin.dc.html:194-249
// (вертикальная линия left:15px, плитка узла 32x32, текст с white-space:pre-line и т.д.).
// Данные — useInfiniteQuery по курсору before=<tgMessageId>, первая страница 50 сообщений
// (бриф задачи 12). Реалтайм — useChannelStream (lib/ws.ts) вставляет message.new в тот же кэш.
export function MessageTimeline({ channelId }: MessageTimelineProps) {
  useChannelStream(channelId)

  // Курсор — tgMessageId последней строки страницы (см. fetchMessages). Общий помощник
  // useCursorList (lib/use-cursor-list.ts) вынесен из этого же компонента — та же логика
  // infinite-пагинации теперь переиспользуется на Positions/Actions/истории закрытых сделок.
  const { items: messages, fetchNextPage, hasNextPage, isFetchingNextPage } = useCursorList<MessageDto>({
    queryKey: messagesQueryKey(channelId),
    fetchPage: (before) => fetchMessages(channelId, before as number | undefined),
    getCursor: (m) => m.tgMessageId,
    pageSize: PAGE_SIZE,
  })

  return (
    <div className="relative max-w-[720px]">
      <div className="absolute bottom-[26px] left-[15px] top-[22px] w-px bg-white/[.08]" />
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
      <LoadMore
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        className="relative pb-[26px] pl-[50px]"
      />
    </div>
  )
}

function MessageRow({ message }: { message: MessageDto }) {
  const hasActions = message.actions.length > 0
  const navigate = useNavigate()

  // Task 6 (Ф2, design/project/Admin.dc.html:220-243,557-559): у сообщений С действиями
  // AI-саммари рисуется ПОД блоком actions (та же "результат"-панель), но только когда решение
  // пришло от AI (summaryStyle: `has && isAi && m.summary`) — для method='auto'/'review' саммари
  // здесь не показывается, даже если backend его когда-нибудь заполнит. У сообщений БЕЗ действий
  // (commentary) саммари — отдельная note-строка (noteStyle: `!has && m.summary`), метод не важен.
  const showResultSummary = hasActions && message.method === 'ai' && Boolean(message.aiSummary)
  const showNoteSummary = !hasActions && Boolean(message.aiSummary)

  // Сообщение прилетает в таймлайн СРАЗУ (tg-ingest, status='received'), а действия и AI-саммари
  // дописывает движок секундами позже — и до этого узел выглядел точно как «шум»: пусто, без следа
  // разбора. Оператор думал, что бот проигнорировал сигнал, и обновлял страницу. Теперь на их месте
  // крутится лоадер, а по 'message.updated' (outbox пересобирает узел) он сменяется результатом.
  const pending = isMessagePending(message.status)

  return (
    <div className="relative flex gap-[18px] pb-[26px]" data-testid="message-row">
      <NodeTile actions={message.actions} />
      <div className="min-w-0 flex-1 pt-[5px]">
        <div className="mb-2 flex items-center gap-[9px]">
          <span className="font-mono text-[11.5px] text-muted-2">{formatTime(message.time)}</span>
        </div>

        <div className="whitespace-pre-line text-sm leading-[1.6] text-message">{message.text}</div>

        {message.media.map((media) => (
          <MediaTile key={media.url} media={media} />
        ))}

        {/* Блок actions (1..N строк, task-11-brief.md — приёмка Ф1): под сигналом видны все
            распознанные действия сообщения (иконка+тип+пара+ссылка на сделку или Skipped/Needs
            review), design/project/Admin.dc.html:214-226. */}
        {pending ? (
          <PendingAnalysis />
        ) : hasActions ? (
          <div className="mt-[11px] flex flex-col gap-2">
            {message.actions.map((action, i) => (
              <ActionRow key={i} action={action} onTradeClick={(ref) => navigate(`/positions?tr=${encodeURIComponent(ref)}`)} />
            ))}
            {showResultSummary ? <AiSummary text={message.aiSummary!} variant="result" /> : null}
          </div>
        ) : showNoteSummary ? (
          <AiSummary text={message.aiSummary!} variant="note" />
        ) : message.statusReason ? (
          // Разбор не дал ни одного действия, но причина известна: канал выключен оператором,
          // сообщение старше водяного знака истории, либо биржа отвергла исполнение по существу.
          // Без этой плашки узел выглядел бы как обычный шум, и оператор не понял бы, почему бот
          // промолчал именно здесь.
          <SkippedNote status={message.status} reason={message.statusReason} />
        ) : null}
      </div>
    </div>
  )
}

function ActionRow({ action, onTradeClick }: { action: MessageActionDto; onTradeClick: (ref: string) => void }) {
  const Icon = getActionIcon(action.icon)
  const color = actionIconColor(action.type, action.side)

  return (
    <div className="flex flex-wrap items-center gap-[10px]" data-testid="timeline-action-row">
      <Icon size={15} color={color} className="flex-none" />
      <span className="text-[12.5px] font-semibold tracking-[.02em]" style={{ color }}>
        {actionSummary(action.type, null)}
      </span>
      {action.pair ? <span className="font-mono text-[12.5px] leading-none text-muted-2">{action.pair}</span> : null}
      {action.skipReason ? (
        <span className="inline-flex flex-wrap items-center gap-[6px]">
          <span
            title={action.skipReason}
            className="inline-flex items-center rounded-[5px] bg-skipped-bg px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[.04em] text-skipped"
          >
            {isNeedsReviewReason(action.skipReason) ? 'Needs review' : 'Skipped'}
          </span>
          {/* Причина текстом, а не только в подсказке: раньше оператор видел безликое «Skipped» и не
              понимал, почему сделки нет — «нет стопа» и «символа нет на бирже» выглядели одинаково. */}
          <span className="text-[11.5px] leading-none text-muted-2">{skipReasonLabel(action.skipReason)}</span>
        </span>
      ) : action.tradeRef ? (
        <button
          type="button"
          onClick={() => onTradeClick(action.tradeRef!)}
          className="inline-flex cursor-pointer items-center gap-[5px] rounded-md border-none bg-white/5 px-[9px] py-1 font-mono text-xs font-semibold text-[#d4d4d8] transition-colors hover:bg-[rgba(255,106,31,.12)] hover:text-accent-hover"
        >
          {`Trade ${normalizeTradeRef(action.tradeRef)}`}
          <ArrowUpRight size={13} className="flex-none" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * Причина, по которой у сообщения нет ни одного действия — берётся из статуса САМОГО сообщения.
 * Подпись зависит от статуса: `needs_review` (напр. биржа отвергла исполнение по существу —
 * main.ts) требует внимания оператора, `archived` — история канала, всё остальное — пропуск по
 * решению оператора. Одна общая надпись «Skipped» на все три случая ввела бы в заблуждение.
 */
function statusNoteLabel(status: MessageDto['status']): string {
  if (status === 'needs_review') return 'Needs review'
  if (status === 'archived') return 'Archived'
  return 'Skipped'
}

function SkippedNote({ status, reason }: { status: MessageDto['status']; reason: string }) {
  return (
    <div className="mt-[11px] inline-flex flex-wrap items-center gap-[6px]" data-testid="message-skipped-note">
      <span
        title={reason}
        className="inline-flex items-center rounded-[5px] bg-skipped-bg px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[.04em] text-skipped"
      >
        {statusNoteLabel(status)}
      </span>
      <span className="text-[11.5px] leading-none text-muted-2">{skipReasonLabel(reason)}</span>
    </div>
  )
}

function NodeTile({ actions }: { actions: readonly MessageActionDto[] }) {
  const first = actions[0]
  if (!first) {
    return (
      <div
        className="relative z-[1] flex h-8 w-8 flex-none items-center justify-center bg-black"
        data-testid="node-tile"
      >
        <span
          className="block h-[7px] w-[7px] rounded-full"
          style={{ background: '#3a3a40' }}
          data-testid="node-dot"
        />
      </div>
    )
  }

  // Плитка узла с иконкой ПЕРВОГО действия сообщения (design/project/Admin.dc.html:198-203) —
  // сообщений с несколькими actions в CH1 мало (управляющие reply редко несут больше одного op),
  // а сама плитка узла — это "что вообще произошло тут", не полный список (он ниже, в ActionRow).
  const Icon = getActionIcon(first.icon)
  return (
    <div
      className="relative z-[1] flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-white/[.12] bg-[#161618]"
      data-testid="node-tile"
    >
      <Icon size={16} color={actionIconColor(first.type, first.side)} className="flex-none" />
    </div>
  )
}

function MediaTile({ media }: { media: MessageDto['media'][number] }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className="mt-3 flex h-[176px] w-full max-w-[340px] items-center justify-center gap-[9px] overflow-hidden rounded-lg"
        style={{
          border: '1px dashed rgba(255,255,255,.1)',
          background:
            'repeating-linear-gradient(135deg,rgba(255,255,255,.02),rgba(255,255,255,.02) 8px,transparent 8px,transparent 16px)',
        }}
      >
        <ImageIcon size={19} color="#5a5a60" />
        <span className="font-mono text-[11.5px] text-muted-2">
          {media.kind === 'video-thumb' ? 'video preview unavailable' : 'photo unavailable'}
        </span>
      </div>
    )
  }

  return (
    <div
      className="mt-3 h-[176px] w-full max-w-[340px] overflow-hidden rounded-lg"
      style={{ border: '1px solid rgba(255,255,255,.09)', background: '#0a0a0c' }}
    >
      <img
        src={media.url}
        alt=""
        className="block h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

// Два варианта геометрии/цвета 1:1 из дизайна:
// - 'result' — саммари ПОД блоком actions (design:234-237, summaryStyle) — верхняя граница
//   rgba(255,255,255,.06), паддинг сверху 11px, цвет текста #9a9aa0 (нет точного tailwind-токена —
//   arbitrary-класс, как и в остальном коде, напр. text-[#d4d4d8] в ActionRow ниже).
// - 'note' — саммари БЕЗ actions (design:240-243, noteStyle) — просто отступ сверху 11px,
//   без границы, цвет muted-1 (#6b6b70, уже заведён токеном в tailwind.config.ts).
function AiSummary({ text, variant }: { text: string; variant: 'result' | 'note' }) {
  return (
    <div
      className={
        variant === 'result'
          ? 'flex items-start gap-2 border-t border-white/[.06] pt-[11px]'
          : 'mt-[11px] flex items-start gap-2'
      }
      data-testid="ai-summary"
    >
      <span className="flex h-[19px] flex-none items-center">
        <Sparkles size={13} color="#ff8a4d" />
      </span>
      <span
        className={
          variant === 'result'
            ? 'text-[12.5px] font-light leading-[1.55] text-[#9a9aa0]'
            : 'text-[12.5px] font-light leading-[1.55] text-muted-1'
        }
      >
        {text}
      </span>
    </div>
  )
}

/**
 * Заглушка на месте действий/саммари, пока движок разбирает сообщение.
 *
 * Без неё узел свежего сообщения был неотличим от «шума» (пустой), и оператор не понимал, дошёл ли
 * сигнал до бота: результат появлялся только после перезагрузки страницы.
 */
function PendingAnalysis() {
  return (
    <div className="mt-[11px] flex items-center gap-[9px]" data-testid="message-pending">
      <Loader2 size={14} className="flex-none animate-spin text-muted-2" />
      <span className="text-[12px] leading-none text-muted-2">Parsing message…</span>
    </div>
  )
}
