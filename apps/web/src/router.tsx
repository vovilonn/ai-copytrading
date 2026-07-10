import { Navigate, createBrowserRouter } from 'react-router-dom'
import { RedirectIfAuthed, RequireAuth } from './components/auth-guard.js'
import ActionsPage from './routes/actions.js'
import ChannelPage from './routes/channel.js'
import ChannelsPage from './routes/channels.js'
import Layout from './routes/layout.js'
import LoginPage from './routes/login.js'
import PositionsPage from './routes/positions.js'

// Роутинг задач 10-11: /login отдельно (без сайдбара), остальные роуты — под общим Layout
// (сайдбар/топбар/bottom nav), защищённым единственным RequireAuth на родителе.
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
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/channels" replace /> },
      { path: 'channels', element: <ChannelsPage /> },
      { path: 'channels/:id', element: <ChannelPage /> },
      { path: 'actions', element: <ActionsPage /> },
      { path: 'positions', element: <PositionsPage /> },
    ],
  },
])
