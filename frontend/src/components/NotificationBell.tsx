import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getUnreadCount, notificationsChangedEvent } from '../api/integrationsApi'
import Icon from './ui/Icon'

const refreshIntervalMs = 60_000

/** Sem a migração ou fora do ar, some sem atrapalhar o restante da tela. */
function NotificationBell() {
  const { pathname } = useLocation()
  const [unread, setUnread] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () => {
      getUnreadCount()
        .then((data) => {
          if (active) setUnread(data.unread)
        })
        .catch(() => {
          if (active) setUnread(null)
        })
    }

    refresh()
    const timer = window.setInterval(refresh, refreshIntervalMs)
    window.addEventListener(notificationsChangedEvent, refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener(notificationsChangedEvent, refresh)
    }
  }, [pathname])

  if (unread === null) return null

  const label = unread === 0 ? 'Notificações' : `Notificações: ${unread} não lidas`
  return (
    <Link className="notification-bell" to="/notificacoes" aria-label={label} title={label}>
      <Icon name="notifications" size={20} />
      {unread > 0 && (
        <span className="notification-bell-count" aria-hidden="true">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  )
}

export default NotificationBell
