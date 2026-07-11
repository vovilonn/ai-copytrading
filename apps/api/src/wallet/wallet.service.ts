import { Inject, Injectable } from '@nestjs/common'
import type { AccountWalletDto } from 'shared/dto.js'
import { DatabaseService } from '../db/database.service.js'
import { PositionsService } from '../positions/positions.service.js'

/** '$10,000.00' — баланс/equity без знака (всегда неотрицательны, в отличие от signedMoney PnL),
 *  с 2 знаками. Пустой снапшот → '$0.00' (план Task 1: "totals '0' / '$0.00' в формате money"). */
function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

@Injectable()
export class WalletService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PositionsService) private readonly positions: PositionsService,
  ) {}

  /** GET /api/account/wallet — последний account-level снапшот (channel_id IS NULL, пишет движок
   *  в Task 3) + per-channel PnL (переиспользуем PositionsService.getStatsByChannel, не дублируя
   *  SQL). Снапшотов ещё нет → equity/balance '$0.00', asOf=null (фронт покажет "нет данных"). */
  async getWallet(): Promise<AccountWalletDto> {
    const snapshot = await this.database.db
      .selectFrom('wallet_snapshots')
      .select(['total_equity', 'available_balance', 'currency', 'created_at'])
      .where('channel_id', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()

    const perChannel = await this.positions.getStatsByChannel()

    if (!snapshot) {
      return {
        totalEquity: money(0),
        availableBalance: money(0),
        currency: 'USDT',
        asOf: null,
        perChannel,
      }
    }

    return {
      totalEquity: money(Number(snapshot.total_equity)),
      availableBalance: money(Number(snapshot.available_balance)),
      currency: snapshot.currency,
      asOf: snapshot.created_at.toISOString(),
      perChannel,
    }
  }
}
