import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import type { PendingOrderDto } from 'shared/dto.js'
import { formatDecimal } from 'shared/numbers.js'
import { DatabaseService } from '../db/database.service.js'

@Injectable()
export class PendingOrdersService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * GET /api/orders/pending (task-3-brief.md): отложенные лимитки НА ВХОД — `status='submitted'
   * AND order_type='limit' AND reduce_only=false AND purpose IN ('entry','add')`. TP/SL — тоже
   * limit-ордера в статусе 'submitted', но `reduce_only=true` и БЕЗ TTL-свипа (design spec §9:
   * протекторы уже открытой позиции, не "отложенные лимитки") — уже показаны на Positions, здесь
   * явно исключены условием reduce_only=false. filled/cancelled/rejected/expired — terminal-статусы,
   * условие status='submitted' их тоже исключает.
   *
   * ttlExpiresAt в ответе — ЭФФЕКТИВНЫЙ дедлайн TTL-свипа (apps/engine/src/main.ts::
   * sweepExpiredLimitOrders), не голая колонка `orders.ttl_expires_at`: ни DryRunAdapter, ни
   * BybitAdapter (apps/engine/src/execution/*.adapter.ts) никогда явно не проставляют это поле при
   * вставке ордера — оно остаётся NULL, а сам свип использует запасной вариант
   * `COALESCE(ttl_expires_at, created_at + channel_settings.limit_ttl_sec)`. Повторяем ТУ ЖЕ
   * формулу здесь — иначе обратный отсчёт на фронте не совпадал бы с реальным моментом
   * авто-отмены. LEFT JOIN channel_settings (не INNER) + COALESCE(..., 604800) — защитный
   * фолбэк на случай отсутствующей строки настроек (ChannelSeedService её обычно создаёт, но
   * FK-то на уровне схемы не гарантирован).
   *
   * Сортировка по эффективному ttl ASC — скоро истекающие лимитки наверху (бриф).
   */
  async listPending(): Promise<PendingOrderDto[]> {
    const rows = await this.database.db
      .selectFrom('orders as o')
      .innerJoin('channels as c', 'c.id', 'o.channel_id')
      .leftJoin('trades as t', 't.id', 'o.trade_id')
      .leftJoin('channel_settings as cs', 'cs.channel_id', 'o.channel_id')
      .select([
        'o.id as id',
        'o.symbol as symbol',
        'o.side as side',
        'o.purpose as purpose',
        'o.price as price',
        'o.qty as qty',
        'o.order_link_id as order_link_id',
        'o.created_at as created_at',
        'o.submitted_at as submitted_at',
        'o.channel_id as channel_id',
        'c.title as channel_title',
        'c.key as channel_key',
        't.human_ref as human_ref',
        sql<Date>`COALESCE(o.ttl_expires_at, o.created_at + make_interval(secs => COALESCE(cs.limit_ttl_sec, 604800)))`.as(
          'effective_ttl',
        ),
      ])
      .where('o.status', '=', 'submitted')
      .where('o.order_type', '=', 'limit')
      .where('o.reduce_only', '=', false)
      .where('o.purpose', 'in', ['entry', 'add'])
      .orderBy('effective_ttl', 'asc')
      .execute()

    return rows.map(
      (row): PendingOrderDto => ({
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        purpose: row.purpose,
        price: row.price !== null ? formatDecimal(row.price) : '0',
        qty: row.qty !== null ? formatDecimal(row.qty) : '0',
        channelId: row.channel_id,
        channelTitle: row.channel_title ?? row.channel_key,
        tradeRef: row.human_ref ? `#${row.human_ref}` : null,
        orderLinkId: row.order_link_id,
        createdAt: row.created_at.toISOString(),
        submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
        ttlExpiresAt: row.effective_ttl.toISOString(),
      }),
    )
  }
}
