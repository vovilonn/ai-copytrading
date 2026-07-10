import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Прокси в дев-сервере пробрасывает /auth, /channels, /media и /socket.io на NestJS API
// (127.0.0.1:3000) с сохранением кук — иначе браузер видит два разных origin и httpOnly-кука
// авторизации не долетает до API.
const apiTarget = 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: apiTarget, changeOrigin: true },
      '/channels': { target: apiTarget, changeOrigin: true },
      '/media': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
})
