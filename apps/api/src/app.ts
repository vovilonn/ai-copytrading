// reflect-metadata должен быть загружен ДО того, как модуль оценит любой декорированный класс
// (контроллеры/провайдеры ниже по цепочке импортов из ./app.module.js) — статические импорты
// в ESM выполняются по порядку следования, поэтому этот импорт обязан быть первым в файле.
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module.js'

/** Общая точка сборки Nest-приложения для main.ts (реальный запуск) и e2e-тестов (supertest). */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] })
  app.use(cookieParser())
  // Задача 12c: все HTTP-роуты (/auth/*, /channels/*, /media/*) переезжают под /api/*, чтобы
  // dev-прокси Vite (apps/web/vite.config.ts) мог проксировать РОВНО /api и /socket.io, не
  // перехватывая SPA-роут /channels/:id как HTTP-запрос к API при жёсткой перезагрузке
  // страницы. socket.io на этот префикс не смотрит — его путь (/socket.io) задаётся отдельно
  // и не является Nest HTTP-роутом (см. RealtimeGateway).
  app.setGlobalPrefix('api')
  return app
}
