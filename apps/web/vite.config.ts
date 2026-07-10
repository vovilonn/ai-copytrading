import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Прокси в дев-сервере пробрасывает ТОЛЬКО /api и /socket.io на NestJS API (127.0.0.1:3000)
// с сохранением кук — иначе браузер видит два разных origin и httpOnly-кука авторизации
// не долетает до API. Задача 12c: раньше здесь были ещё /channels и /auth отдельными
// префиксами — прокси перехватывал SPA-роут /channels/:id как HTTP-запрос к API при
// жёсткой перезагрузке страницы (F5 отдавал сырой JSON вместо приложения). Весь HTTP API
// смонтирован под /api (apps/api/src/app.ts, setGlobalPrefix('api')) именно для того, чтобы
// прокси мог однозначно отличить запрос к API от SPA-роута по одному префиксу.
const apiTarget = 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
})
