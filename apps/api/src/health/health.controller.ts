import { Controller, Get } from '@nestjs/common'
import { Public } from '../auth/public.decorator.js'

/** Healthcheck докер-компоуза (задача 13): публичный, без БД и без куки — не должен падать
 *  из-за истёкшей сессии или временной недоступности postgres, иначе контейнер api никогда
 *  не станет healthy и compose не поднимет зависящие от него сервисы. */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  get(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
