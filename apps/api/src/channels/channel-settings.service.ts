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

// Валидирует ТОЛЬКО переданные поля (частичный PATCH) — отсутствующее поле в теле запроса
// не трогает существующее значение в БД и не проверяется здесь. Бросает BadRequestException
// (-> 400) на первое найденное нарушение, а не собирает список ошибок — форма на фронте
// проверяет то же самое до отправки (apps/web/src/routes/channel.tsx), сюда долетают либо
// валидные данные, либо намеренно некорректный запрос (curl/тест).
function assertValid(input: UpdateChannelSettingsInput): void {
  if (input.tradeSize !== undefined) {
    const n = Number(input.tradeSize)
    if (!Number.isFinite(n) || n <= 0) {
      throw new BadRequestException('tradeSize должен быть числом больше 0')
    }
  }
  if (input.maxLeverage !== undefined) {
    const n = Number(input.maxLeverage)
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('maxLeverage должен быть числом >= 1')
    }
  }
  if (input.defaultLeverage !== undefined && input.defaultLeverage !== null) {
    const n = Number(input.defaultLeverage)
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('defaultLeverage должен быть числом >= 1 или null')
    }
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
