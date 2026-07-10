import { Navigate, createBrowserRouter } from 'react-router-dom'
import { RedirectIfAuthed, RequireAuth } from './components/auth-guard.js'
import ChannelPage from './routes/channel.js'
import ChannelsPage from './routes/channels.js'
import LoginPage from './routes/login.js'

// Роутинг задачи 10: /login, /channels, /channels/:id + гарды авторизации.
// Layout (сайдбар/топбар/bottom nav) появится в задаче 11 и обернёт защищённые роуты.
export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <RedirectIfAuthed>
        <LoginPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: '/channels',
    element: (
      <RequireAuth>
        <ChannelsPage />
      </RequireAuth>
    ),
  },
  {
    path: '/channels/:id',
    element: (
      <RequireAuth>
        <ChannelPage />
      </RequireAuth>
    ),
  },
  { path: '/', element: <Navigate to="/channels" replace /> },
])
