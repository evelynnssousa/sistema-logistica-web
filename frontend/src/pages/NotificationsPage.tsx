import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsChangedEvent,
} from '../api/integrationsApi'
import type { UserNotification } from '../api/integrationsApi'
import { errorMessage, formatDateTime } from '../api/modulesApi'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterBar, FilterSelect } from '../components/ui/Filters'
import PageHeader from '../components/ui/PageHeader'
import Pagination from '../components/ui/Pagination'

type Listing = Awaited<ReturnType<typeof listNotifications>>

function NotificationsPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setListing(await listNotifications({ unread: filter === 'unread', pending: filter === 'pending', page }))
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível carregar as notificações.'))
    }
  }, [filter, page])

  useEffect(() => {
    let active = true
    listNotifications({ unread: filter === 'unread', pending: filter === 'pending', page })
      .then((data) => {
        if (active) {
          setListing(data)
          setError('')
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível carregar as notificações.'))
      })
    return () => {
      active = false
    }
  }, [filter, page])

  async function open(notification: UserNotification) {
    try {
      if (!notification.readAt) {
        await markNotificationRead(notification.id)
        window.dispatchEvent(new Event(notificationsChangedEvent))
      }
      if (notification.link) navigate(notification.link)
      else await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível abrir a notificação.'))
    }
  }

  async function markAll() {
    try {
      await markAllNotificationsRead()
      window.dispatchEvent(new Event(notificationsChangedEvent))
      await load()
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível marcar as notificações.'))
    }
  }

  return (
    <div className="admin-module-page notifications-page">
      <PageHeader
        title="Notificações"
        description="Avisos sobre as solicitações que você acompanha ou atende."
        actions={
          <button
            type="button"
            className="maintenance-secondary-button"
            disabled={!listing || listing.unread === 0}
            onClick={() => void markAll()}
          >
            Marcar todas como lidas
          </button>
        }
      />

      <FilterBar
        label="Filtros de notificações"
        canClear={Boolean(filter)}
        onClear={() => {
          setFilter('')
          setPage(1)
        }}
      >
        <FilterSelect
          label="Situação"
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setPage(1)
          }}
          allLabel="Todas"
          options={[
            { value: 'unread', label: 'Não lidas' },
            { value: 'pending', label: 'Pendentes de providência' },
          ]}
        />
      </FilterBar>

      {error && <Alert tone="error">{error}</Alert>}
      {!listing && !error && <Loading label="Carregando notificações..." />}

      {listing && (
        <section className="ui-card ui-stacked" aria-label="Lista de notificações">
          {listing.notifications.length === 0 ? (
            <EmptyState icon="notifications" title="Nenhuma notificação">
              Os avisos aparecem aqui quando houver novidades.
            </EmptyState>
          ) : (
            <ul className="notification-list">
              {listing.notifications.map((notification) => (
                <li key={notification.id} className={notification.readAt ? '' : 'is-unread'}>
                  <button type="button" onClick={() => void open(notification)}>
                    <strong>
                      {notification.title}
                      {!notification.readAt && <span className="notification-unread-label">Não lida</span>}
                      {!notification.readAt && notification.requiresAction && (
                        <span className="notification-action-label">Exige providência</span>
                      )}
                    </strong>
                    <span>{notification.message}</span>
                    <small>{formatDateTime(notification.createdAt)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Pagination
            page={listing.page}
            summary={`${listing.total} no total`}
            hasNext={listing.page * listing.pageSize < listing.total}
            onChange={setPage}
          />
        </section>
      )}
    </div>
  )
}

export default NotificationsPage
