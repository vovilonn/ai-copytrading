import { Controller, Get, Inject } from '@nestjs/common'
import type { MetricsDto } from 'shared/dto.js'
import { MetricsService } from './metrics.service.js'

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  // GET /api/metrics/ai (JwtGuard — глобальный APP_GUARD, см. app.module.ts) — сводка вызовов
  // AI-модели + действий движка (executed/skipped-по-причинам) + trades. Путь исторически назван
  // по брифу задачи 5 ("наблюдаемость AI-слоя"), но тело покрывает и действия/сделки — см. MetricsDto.
  @Get('ai')
  async getAiMetrics(): Promise<MetricsDto> {
    return this.metrics.getMetrics()
  }
}
