import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from './components/ui/sonner.js'
import './index.css'
import { createQueryClient } from './lib/query-client.js'
import { router } from './router.js'

// router.navigate — createBrowserRouter отдаёт объект роутера с методом navigate, тем же, что
// использует RouterProvider ниже, поэтому глобальный обработчик 401 (см. query-client.ts) может
// увести на /login и вне React-дерева, не пробрасывая useNavigate() через пропсы.
const queryClient = createQueryClient((to) => void router.navigate(to))

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)
