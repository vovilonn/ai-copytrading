import { useParams } from 'react-router-dom'

// Заглушка задачи 10/11 — таймлайн сообщений канала появится в задаче 12.
export default function ChannelPage() {
  const { id } = useParams()
  return <div className="text-fg">Channel #{id}</div>
}
