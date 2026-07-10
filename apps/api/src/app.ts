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
  return app
}
