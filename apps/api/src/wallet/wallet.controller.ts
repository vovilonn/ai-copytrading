import { Controller, Get, Inject } from '@nestjs/common'
import type { AccountWalletDto } from 'shared/dto.js'
import { WalletService } from './wallet.service.js'

// Отдельный префикс /account (не /positions) — баланс концептуально шире позиций: это состояние
// всего demo-аккаунта. Закрыт глобальным JwtGuard (app.module.ts), как и остальные роуты.
@Controller('account')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Get('wallet')
  async getWallet(): Promise<AccountWalletDto> {
    return this.wallet.getWallet()
  }
}
