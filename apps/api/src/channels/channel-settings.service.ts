import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import type { Updateable } from 'kysely'
import type { ChannelSettingsDto } from 'shared/dto.js'
import type { DB } from '../db/database.js'
import { DatabaseService } from '../db/database.service.js'
import { formatNumeric } from './channels.service.js'

// Тело PATCH /api/channels/:id/settings — все поля опциональны (частичное обновление),
// деньги/плечо приходят строками (та же конвенция, что и во всём остальном API — см.
// packages/shared/src/channel-settings.ts, channels.service.ts). defaultLeverage: null —
// явный сигнал «очистить поле» (отличается от undefined — «не трогать»).
export interface UpdateChannelSettingsInput {
  enabled?: boolean
  tradeSize?: string
  maxLeverage?: string
  defaultLeverage?: string | null
  crossMargin?: boolean
}

interface ChannelSettingsRow {
  channel_id: number
  enabled: boolean
  trade_size: string
  max_leverage: string
  default_leverage: string | null
  cross_margin: boolean
}

function toChannelSettingsDto(row: ChannelSettingsRow): ChannelSettingsDto {
  return {
    channelId: row.channel_id,
    enabled: row.enabled,
    tradeSize: `$${formatNumeric(row.trade_size)}`,
    maxLeverage: `${formatNumeric(row.max_leverage)}x`,
    defaultLeverage: row.default_leverage !== null ? `${formatNumeric(row.default_leverage)}x` : null,
    crossMargin: row.cross_margin,
  }
}

// Строгий формат неотрицательного десятичного числа: только цифры и одна точка. Сознательно
// НЕ полагаемся на Number() как на первичную проверку (адверсариал-ревью M1): Number('0x10')=16,
// Number('1e3')=1000, Number(' 5 ')=5 прошли бы валидацию, а затем ИСХОДНАЯ строка ('0x10'/'1e3')
// пишется в NUMERIC-колонку → Postgres её отвергает → 500 вместо 400. Regex отсекает hex/экспоненту/
// знак/пробелы ДО записи; Number() ниже безопасен только для проверки диапазона.
const DECIMAL_RE = /^\d+(?:\.\d+)?$/

// Разбирает поле-число с проверкой формата и диапазона. Верхние границы — не косметика:
// max_leverage/default_leverage это NUMERIC(6,2) (max 9999.99), '100000' дало бы numeric overflow
// → 500; плюс плечо >125 бессмысленно (предел биржи). trade_size — NUMERIC(20,8), кап 1e9 отсекает
// абсурд, оставаясь далеко внутри колонки.
function parseDecimalField(
  raw: string,
  field: string,
  { min, max, minInclusive = true }: { min: number; max: number; minInclusive?: boolean },
): void {
  if (typeof raw !== 'string' || !DECIMAL_RE.test(raw)) {
    throw new BadRequestException(`${field}: ожидается десятичное число без знака (например "300" или "10.5")`)
  }
  const n = Number(raw)
  const belowMin = minInclusive ? n < min : n <= min
  if (!Number.isFinite(n) || belowMin || n > max) {
    const lo = minInclusive ? `>= ${min}` : `> ${min}`
    throw new BadRequestException(`${field}: должно быть ${lo} и <= ${max}`)
  }
}

// Валидирует ТОЛЬКО переданные поля (частичный PATCH) — отсутствующее поле в теле запроса
// не трогает существующее значение в БД и не проверяется здесь. Бросает BadRequestException
// (-> 400) на первое найденное нарушение, а не собирает список ошибок — форма на фронте
// проверяет то же самое до отправки (apps/web/src/routes/channel.tsx), сюда долетают либо
// валидные данные, либо намеренно некорректный запрос (curl/тест).
function assertValid(input: UpdateChannelSettingsInput): void {
  if (input.tradeSize !== undefined) {
    parseDecimalField(input.tradeSize, 'tradeSize', { min: 0, max: 1_000_000_000, minInclusive: false })
  }
  if (input.maxLeverage !== undefined) {
    parseDecimalField(input.maxLeverage, 'maxLeverage', { min: 1, max: 125 })
  }
  if (input.defaultLeverage !== undefined && input.defaultLeverage !== null) {
    parseDecimalField(input.defaultLeverage, 'defaultLeverage', { min: 1, max: 125 })
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new BadRequestException('enabled должен быть boolean')
  }
  if (input.crossMargin !== undefined && typeof input.crossMargin !== 'boolean') {
    throw new BadRequestException('crossMargin должен быть boolean')
  }
}

@Injectable()
export class ChannelSettingsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async update(channelId: number, input: UpdateChannelSettingsInput): Promise<ChannelSettingsDto> {
    assertValid(input)

    // Собираем set() только из полей, реально присутствующих в теле запроса — kysely .set({})
    // на пустом объекте — валидный no-op UPDATE (просто обновит updated_at), не 500.
    const patch: Updateable<DB['channel_settings']> = { updated_at: new Date() }
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.tradeSize !== undefined) patch.trade_size = input.tradeSize
    if (input.maxLeverage !== undefined) patch.max_leverage = input.maxLeverage
    if (input.defaultLeverage !== undefined) patch.default_leverage = input.defaultLeverage
    if (input.crossMargin !== undefined) patch.cross_margin = input.crossMargin

    const updated = await this.database.db
      .updateTable('channel_settings')
      .set(patch)
      .where('channel_id', '=', channelId)
      .returningAll()
      .executeTakeFirst()

    if (!updated) throw new NotFoundException(`Канал ${channelId} не найден`)
    return toChannelSettingsDto(updated)
  }
}
