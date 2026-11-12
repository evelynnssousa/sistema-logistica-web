import type { Permission } from '../auth/permissions.js'

/**
 * Todas as rotas da API e o acesso exigido por cada uma. Serve aos testes:
 * routeInventory.test.ts falha se existir rota fora desta lista, e a integração
 * percorre a lista para comprovar cada permissão contra a API real.
 */
export type RouteAccess = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
} & (
  | { access: 'public'; reason: string }
  | { access: 'session' }
  | {
      access: 'permission'
      requires: readonly Permission[]
      // Além das permissões, o perfil precisa ser Administrador.
      administratorOnly?: boolean
    }
)

type OperationalModule = 'maintenance' | 'fleet' | 'flights'

/** Rotas comuns às solicitações. Em Passagens, flights:read vale para todo o caminho. */
function requestRoutes(module: OperationalModule): RouteAccess[] {
  const base = `/${module}/requests`
  const read = `${module}:read` as Permission
  const scope: readonly Permission[] = module === 'flights' ? [read] : []
  const update: readonly Permission[] = [...scope, 'requests:update', `${module}:update` as Permission]

  return [
    { method: 'GET', path: base, access: 'permission', requires: [read] },
    { method: 'POST', path: base, access: 'permission', requires: [...scope, 'requests:create', `${module}:create` as Permission] },
    { method: 'GET', path: `${base}/:requestId`, access: 'permission', requires: [read] },
    { method: 'PATCH', path: `${base}/:requestId`, access: 'permission', requires: update },
    // Também aceita requests:cancel_own no lugar de requests:cancel, só para a própria solicitação
    // antes do atendimento (canCancelOwnRequest); o mapa registra o caminho geral.
    { method: 'POST', path: `${base}/:requestId/cancel`, access: 'permission', requires: ['requests:cancel', read] },
    { method: 'POST', path: `${base}/duplicates`, access: 'permission', requires: [...scope, 'requests:create', `${module}:create` as Permission] },
    { method: 'POST', path: `${base}/:requestId/return`, access: 'permission', requires: update },
    { method: 'POST', path: `${base}/:requestId/return/close`, access: 'permission', requires: update },
    { method: 'POST', path: `${base}/:requestId/return/respond`, access: 'permission', requires: [read] },
    { method: 'GET', path: `${base}/:requestId/report`, access: 'permission', requires: [read] },
    ...(module === 'flights'
      ? ([
          { method: 'POST', path: `${base}/:requestId/advance`, access: 'permission', requires: update },
          { method: 'PUT', path: `${base}/:requestId/passengers`, access: 'permission', requires: update },
        ] satisfies RouteAccess[])
      : ([
          { method: 'POST', path: `${base}/:requestId/schedule`, access: 'permission', requires: ['requests:schedule', `${module}:schedule` as Permission] },
          { method: 'POST', path: `${base}/:requestId/start`, access: 'permission', requires: update },
          { method: 'POST', path: `${base}/:requestId/complete`, access: 'permission', requires: update },
        ] satisfies RouteAccess[])),
    ...(module === 'fleet'
      ? ([
          { method: 'POST', path: `${base}/:requestId/occurrences`, access: 'permission', requires: update },
        ] satisfies RouteAccess[])
      : []),
  ]
}

const slmRead: readonly Permission[] = ['slm_central:read', 'requests:read_all']
const slmManage: readonly Permission[] = ['slm_central:manage', 'requests:read_all', 'requests:update']

export const routeAccessMap: readonly RouteAccess[] = [
  { method: 'GET', path: '/health', access: 'public', reason: 'Saúde da API' },
  { method: 'GET', path: '/public/forms/registration', access: 'public', reason: 'Textos do formulário de cadastro, que abre sem sessão' },
  { method: 'POST', path: '/auth/register', access: 'public', reason: 'Pedido de acesso, limitado por IP' },
  { method: 'POST', path: '/auth/login', access: 'public', reason: 'Entrada, com limite de tentativas' },
  { method: 'POST', path: '/auth/logout', access: 'public', reason: 'Sem sessão só limpa o cookie; com sessão exige CSRF' },
  { method: 'POST', path: '/auth/password-recovery/request', access: 'public', reason: 'Recuperação de senha, limitada' },
  { method: 'POST', path: '/auth/password-recovery/reset', access: 'public', reason: 'Recuperação de senha, limitada' },
  { method: 'POST', path: '/auth/password-recovery/reset-link', access: 'public', reason: 'Recuperação de senha por link, limitada' },

  { method: 'GET', path: '/auth/me', access: 'session' },

  { method: 'GET', path: '/admin/registrations/pending', access: 'permission', requires: ['users:approve'] },
  { method: 'POST', path: '/admin/registrations/:userId/approve', access: 'permission', requires: ['users:approve'] },
  { method: 'POST', path: '/admin/registrations/:userId/reject', access: 'permission', requires: ['users:approve'] },
  { method: 'GET', path: '/admin/registrations/institutional-options', access: 'permission', requires: ['users:approve'] },

  { method: 'GET', path: '/admin/permissions', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/audit', access: 'permission', requires: ['audit:read'] },

  { method: 'GET', path: '/admin/users', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/users/:userId', access: 'permission', requires: ['users:read'] },
  { method: 'GET', path: '/admin/users/:userId/history', access: 'permission', requires: ['users:read'] },
  { method: 'PATCH', path: '/admin/users/:userId', access: 'permission', requires: ['users:manage'] },
  { method: 'PUT', path: '/admin/users/:userId/access', access: 'permission', requires: ['users:manage'], administratorOnly: true },
  { method: 'POST', path: '/admin/users/:userId/activate', access: 'permission', requires: ['users:manage'] },
  { method: 'POST', path: '/admin/users/:userId/deactivate', access: 'permission', requires: ['users:manage'] },
  { method: 'GET', path: '/admin/users/:userId/institutional-links', access: 'permission', requires: ['users:read'] },
  { method: 'PUT', path: '/admin/users/:userId/institutional-links', access: 'permission', requires: ['users:manage'], administratorOnly: true },

  { method: 'GET', path: '/flights/requests/:requestId/passengers', access: 'permission', requires: ['flights:read'] },
  { method: 'GET', path: '/flights/passengers/:passengerId/cpf', access: 'permission', requires: ['flights:read', 'flights:cpf:read'] },

  ...requestRoutes('maintenance'),
  ...requestRoutes('fleet'),
  ...requestRoutes('flights'),
  { method: 'GET', path: '/operations/assignees', access: 'permission', requires: ['requests:update'] },
  { method: 'GET', path: '/operations/capabilities', access: 'session' },

  { method: 'GET', path: '/catalog', access: 'session' },
  { method: 'GET', path: '/forms/definitions', access: 'session' },
  { method: 'GET', path: '/settings/catalog', access: 'permission', requires: ['settings:read'] },
  { method: 'POST', path: '/settings/catalog/:category', access: 'permission', requires: ['settings:manage'] },
  { method: 'PATCH', path: '/settings/catalog/:category/:optionId', access: 'permission', requires: ['settings:manage'] },
  { method: 'POST', path: '/settings/catalog/:category/:optionId/activate', access: 'permission', requires: ['settings:manage'] },
  { method: 'POST', path: '/settings/catalog/:category/:optionId/deactivate', access: 'permission', requires: ['settings:manage'] },

  { method: 'GET', path: '/warehouse/materials', access: 'permission', requires: ['warehouse:read'] },
  { method: 'POST', path: '/warehouse/materials', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'PATCH', path: '/warehouse/materials/:materialId', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/requests', access: 'permission', requires: ['warehouse:read'] },
  { method: 'POST', path: '/warehouse/requests', access: 'permission', requires: ['warehouse:read', 'requests:create'] },
  { method: 'POST', path: '/warehouse/external-requests', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/requests/:requestId', access: 'permission', requires: ['warehouse:read'] },
  { method: 'PATCH', path: '/warehouse/requests/:requestId', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'PUT', path: '/warehouse/requests/:requestId/items', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/requests/:requestId/status', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/requests/:requestId/deliver', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'PUT', path: '/warehouse/requests/:requestId/delivery-forecast', access: 'permission', requires: ['warehouse:manage', 'warehouse:forecast'] },
  { method: 'GET', path: '/warehouse/inventory-checks', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/inventory-checks', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/inventory-checks/:checkId', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'PUT', path: '/warehouse/inventory-checks/:checkId/items/:materialId', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/inventory-checks/:checkId/close', access: 'permission', requires: ['warehouse:manage'] },

  // Portal do Motorista: exige o perfil Motorista, conferido na rota, além da lista fechada de driverPolicy.ts.
  { method: 'GET', path: '/driver/me', access: 'session' },
  { method: 'GET', path: '/driver/trips', access: 'session' },
  { method: 'GET', path: '/driver/history', access: 'session' },
  { method: 'GET', path: '/driver/trips/:tripId', access: 'session' },
  { method: 'POST', path: '/driver/trips/:tripId/start', access: 'session' },
  { method: 'POST', path: '/driver/trips/:tripId/finish', access: 'session' },
  { method: 'POST', path: '/driver/trips/:tripId/occurrences', access: 'session' },
  { method: 'POST', path: '/driver/trips/:tripId/occurrences/:occurrenceId/attachments', access: 'session' },
  // Motoristas, pela equipe da Frota.
  { method: 'GET', path: '/fleet/drivers', access: 'permission', requires: ['fleet:manage'] },
  { method: 'GET', path: '/fleet/drivers/assignable', access: 'permission', requires: ['fleet:schedule'] },
  { method: 'POST', path: '/fleet/drivers', access: 'permission', requires: ['fleet:manage'] },
  { method: 'PATCH', path: '/fleet/drivers/:driverId', access: 'permission', requires: ['fleet:manage'] },
  { method: 'GET', path: '/fleet/requests/:requestId/execution', access: 'permission', requires: ['fleet:read', 'requests:read_all'] },
  { method: 'POST', path: '/fleet/requests/:requestId/driver', access: 'permission', requires: ['requests:schedule', 'fleet:schedule'] },
  { method: 'POST', path: '/fleet/requests/:requestId/execution-correction', access: 'permission', requires: ['fleet:execution_correct'] },

  { method: 'GET', path: '/dashboard/summary', access: 'session' },
  { method: 'GET', path: '/reports/summary', access: 'permission', requires: ['reports:read'] },
  { method: 'GET', path: '/reports/operational', access: 'permission', requires: ['reports:read'] },
  { method: 'GET', path: '/calendar/events', access: 'permission', requires: ['calendar:read'] },
  { method: 'GET', path: '/reports/warehouse/spreadsheet', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/reports/fleet/spreadsheet', access: 'permission', requires: ['reports:read', 'fleet:read'] },

  { method: 'GET', path: '/notifications', access: 'session' },
  { method: 'GET', path: '/notifications/unread-count', access: 'session' },
  { method: 'POST', path: '/notifications/read-all', access: 'session' },
  { method: 'POST', path: '/notifications/:notificationId/read', access: 'session' },

  { method: 'GET', path: '/integrations/status', access: 'permission', requires: ['integrations:read'] },
  { method: 'GET', path: '/integrations/templates', access: 'permission', requires: ['integrations:read'] },
  { method: 'GET', path: '/integrations/emails', access: 'permission', requires: ['integrations:read'] },
  { method: 'GET', path: '/integrations/emails/:itemId/attempts', access: 'permission', requires: ['integrations:read'] },
  { method: 'POST', path: '/integrations/emails/:itemId/retry', access: 'permission', requires: ['integrations:manage'] },

  { method: 'GET', path: '/settings/parameters', access: 'permission', requires: ['settings:read'] },
  { method: 'PUT', path: '/settings/parameters/:section', access: 'permission', requires: ['settings:manage'] },

  { method: 'GET', path: '/settings/history', access: 'permission', requires: ['settings:read'] },
  { method: 'GET', path: '/settings/driver-occurrence-types', access: 'permission', requires: ['settings:read'] },
  { method: 'POST', path: '/settings/driver-occurrence-types', access: 'permission', requires: ['settings:manage'] },
  { method: 'PATCH', path: '/settings/driver-occurrence-types/:typeKey', access: 'permission', requires: ['settings:manage'] },

  { method: 'GET', path: '/config/email-templates', access: 'permission', requires: ['email_templates:read'] },
  { method: 'GET', path: '/config/email-templates/:key', access: 'permission', requires: ['email_templates:read'] },
  { method: 'PUT', path: '/config/email-templates/:key/draft', access: 'permission', requires: ['email_templates:edit'] },
  { method: 'POST', path: '/config/email-templates/:key/publish', access: 'permission', requires: ['email_templates:publish'] },
  { method: 'POST', path: '/config/email-templates/:key/restore', access: 'permission', requires: ['config_versions:restore'] },
  { method: 'POST', path: '/config/email-templates/:key/preview', access: 'permission', requires: ['email_templates:read'] },
  { method: 'POST', path: '/config/email-templates/:key/test', access: 'permission', requires: ['email_templates:edit'] },
  { method: 'GET', path: '/config/forms', access: 'permission', requires: ['forms:read'] },
  { method: 'GET', path: '/config/forms/:key', access: 'permission', requires: ['forms:read'] },
  { method: 'POST', path: '/config/forms/:key/validate', access: 'permission', requires: ['forms:read'] },
  { method: 'PUT', path: '/config/forms/:key/draft', access: 'permission', requires: ['forms:edit'] },
  { method: 'POST', path: '/config/forms/:key/publish', access: 'permission', requires: ['forms:publish'] },
  { method: 'POST', path: '/config/forms/:key/restore', access: 'permission', requires: ['config_versions:restore'] },

  // Além da permissão, a rota confere se a pessoa atende o módulo da solicitação.
  { method: 'GET', path: '/communications/:resourceType/:resourceId', access: 'permission', requires: ['communications:read'] },
  { method: 'POST', path: '/communications/:resourceType/:resourceId/compose', access: 'permission', requires: ['communications:send'] },
  { method: 'POST', path: '/communications/:resourceType/:resourceId/preview', access: 'permission', requires: ['communications:send'] },
  { method: 'POST', path: '/communications/:resourceType/:resourceId/send', access: 'permission', requires: ['communications:send'] },
  { method: 'POST', path: '/communications/emails/:emailId/resend', access: 'permission', requires: ['communications:send'] },

  { method: 'GET', path: '/warehouse/requests/:requestId/report', access: 'permission', requires: ['warehouse:read'] },
  { method: 'PUT', path: '/warehouse/stock/:materialId/reserved', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/control-records', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/control-records', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/control-form', access: 'permission', requires: ['warehouse:manage'] },

  { method: 'GET', path: '/slm/overview', access: 'permission', requires: slmRead },
  { method: 'GET', path: '/slm/requests', access: 'permission', requires: slmRead },
  { method: 'GET', path: '/slm/team', access: 'permission', requires: slmRead },
  { method: 'POST', path: '/slm/requests/:requestId/assign', access: 'permission', requires: slmManage },
  { method: 'POST', path: '/slm/requests/:requestId/priority', access: 'permission', requires: slmManage },
  { method: 'POST', path: '/slm/requests/:requestId/deadline', access: 'permission', requires: slmManage },
  { method: 'POST', path: '/slm/requests/:requestId/complexity', access: 'permission', requires: slmManage },
  { method: 'POST', path: '/slm/requests/:requestId/notes', access: 'permission', requires: slmManage },

  // O acesso depende da solicitação: conferido na rota, pelas regras de canReadRequest.
  { method: 'GET', path: '/attachments/resources/:resourceType/:resourceId', access: 'session' },
  { method: 'POST', path: '/attachments/resources/:resourceType/:resourceId', access: 'session' },
  { method: 'GET', path: '/attachments/files/:attachmentId/content', access: 'session' },
  { method: 'POST', path: '/attachments/files/:attachmentId/remove', access: 'session' },
  { method: 'GET', path: '/attachments/capacity', access: 'permission', requires: ['settings:read'] },

  // Cada categoria aplica as permissões de quem pesquisa, no próprio SQL.
  { method: 'GET', path: '/search', access: 'session' },

  { method: 'GET', path: '/fleet/vehicles', access: 'permission', requires: ['fleet:read', 'fleet:update'] },
  { method: 'POST', path: '/fleet/vehicles', access: 'permission', requires: ['fleet:manage'] },
  { method: 'GET', path: '/fleet/vehicles/:vehicleId', access: 'permission', requires: ['fleet:read', 'fleet:update'] },
  { method: 'PATCH', path: '/fleet/vehicles/:vehicleId', access: 'permission', requires: ['fleet:manage'] },
  { method: 'POST', path: '/fleet/vehicles/:vehicleId/logs', access: 'permission', requires: ['fleet:read', 'fleet:update'] },

  { method: 'GET', path: '/maintenance/equipments', access: 'permission', requires: ['maintenance:read', 'maintenance:update'] },
  { method: 'POST', path: '/maintenance/equipments', access: 'permission', requires: ['maintenance:manage'] },
  { method: 'PATCH', path: '/maintenance/equipments/:equipmentId', access: 'permission', requires: ['maintenance:manage'] },
  { method: 'GET', path: '/maintenance/equipments/:equipmentId/history', access: 'permission', requires: ['maintenance:read', 'maintenance:update'] },
  { method: 'GET', path: '/maintenance/requests/:requestId/executions', access: 'permission', requires: ['maintenance:read'] },
  { method: 'POST', path: '/maintenance/requests/:requestId/executions', access: 'permission', requires: ['requests:update', 'maintenance:update'] },

  { method: 'GET', path: '/flights/requests/:requestId/quotes', access: 'permission', requires: ['flights:read', 'requests:update', 'flights:update'] },
  { method: 'POST', path: '/flights/requests/:requestId/quotes', access: 'permission', requires: ['flights:read', 'requests:update', 'flights:update'] },
  { method: 'POST', path: '/flights/requests/:requestId/quotes/:quoteId/select', access: 'permission', requires: ['flights:read', 'requests:update', 'flights:update'] },

  { method: 'GET', path: '/warehouse/stock', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'PUT', path: '/warehouse/stock/:materialId/minimum', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'GET', path: '/warehouse/stock-movements', access: 'permission', requires: ['warehouse:manage'] },
  { method: 'POST', path: '/warehouse/stock-movements', access: 'permission', requires: ['warehouse:manage'] },

  { method: 'GET', path: '/reports/performance', access: 'permission', requires: ['reports:read'] },

  { method: 'GET', path: '/monitoring/status', access: 'permission', requires: ['monitoring:read'] },
  { method: 'GET', path: '/monitoring/events', access: 'permission', requires: ['monitoring:read'] },
  { method: 'GET', path: '/admin/access-review', access: 'permission', requires: ['users:read'] },
  { method: 'POST', path: '/admin/access-review/:userId', access: 'permission', requires: ['users:manage'] },

  { method: 'POST', path: '/auth/sessions/:sessionId/revoke', access: 'session' },
  { method: 'GET', path: '/admin/users/:userId/sessions', access: 'permission', requires: ['users:manage'] },

  { method: 'GET', path: '/auth/sessions', access: 'session' },
  { method: 'POST', path: '/auth/sessions/revoke-others', access: 'session' },
  { method: 'POST', path: '/admin/users/:userId/sessions/revoke', access: 'permission', requires: ['users:manage'] },

  // Controle de Demandas: o acesso depende do perfil (Servidor, Chefe, Diretor, Administrador) e da própria
  // demanda, e é conferido na rota, a partir do banco. Veja demands/demandPolicy.ts.
  { method: 'GET', path: '/demands/context', access: 'session' },
  { method: 'GET', path: '/demands/options', access: 'session' },
  { method: 'GET', path: '/demands/dashboard', access: 'session' },
  { method: 'GET', path: '/demands/reports', access: 'session' },
  { method: 'GET', path: '/demands/reports/export', access: 'session' },
  { method: 'GET', path: '/demands/agenda', access: 'session' },
  { method: 'POST', path: '/demands/agenda/events', access: 'session' },
  { method: 'POST', path: '/demands/agenda/events/:eventId/cancel', access: 'session' },
  { method: 'GET', path: '/demands/preferences', access: 'session' },
  { method: 'PUT', path: '/demands/preferences', access: 'session' },
  { method: 'GET', path: '/demands/attachments/:attachmentId/content', access: 'session' },
  { method: 'POST', path: '/demands/attachments/:attachmentId/remove', access: 'session' },
  { method: 'GET', path: '/demands', access: 'session' },
  { method: 'POST', path: '/demands', access: 'session' },
  { method: 'GET', path: '/demands/:demandId', access: 'session' },
  { method: 'PATCH', path: '/demands/:demandId', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/publish', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/discard', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/assign', access: 'session' },
  { method: 'PUT', path: '/demands/:demandId/collaboration', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/follow', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/status', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/complete', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/reopen', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/cancel', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/comments', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/subtasks', access: 'session' },
  { method: 'PATCH', path: '/demands/:demandId/subtasks/:subtaskId', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/attachments', access: 'session' },
  { method: 'GET', path: '/demands/:demandId/attachment-limits', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/links', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/links/:linkId/remove', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/series/suspend', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/series/resume', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/series/cancel', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/series/skip', access: 'session' },
  { method: 'POST', path: '/demands/:demandId/series/rule', access: 'session' },
  // Setores, integrantes e categorias: a permissão ou o perfil de Diretor. Definir diretores: só a permissão.
  { method: 'GET', path: '/demands/settings/sectors', access: 'permission', requires: ['demands:configure'] },
  { method: 'POST', path: '/demands/settings/sectors', access: 'permission', requires: ['demands:configure'] },
  { method: 'PATCH', path: '/demands/settings/sectors/:sectorId', access: 'permission', requires: ['demands:configure'] },
  { method: 'GET', path: '/demands/settings/users', access: 'permission', requires: ['demands:configure'] },
  { method: 'PUT', path: '/demands/settings/sectors/:sectorId/members/:userId', access: 'permission', requires: ['demands:configure'] },
  { method: 'POST', path: '/demands/settings/sectors/:sectorId/members/:userId/remove', access: 'permission', requires: ['demands:configure'] },
  { method: 'GET', path: '/demands/settings/directorate', access: 'permission', requires: ['demands:configure'] },
  { method: 'PUT', path: '/demands/settings/directorate/:userId', access: 'permission', requires: ['demands:configure'] },
  { method: 'POST', path: '/demands/settings/directorate/:userId/remove', access: 'permission', requires: ['demands:configure'] },
  { method: 'GET', path: '/demands/settings/categories', access: 'permission', requires: ['demands:configure'] },
  { method: 'POST', path: '/demands/settings/categories', access: 'permission', requires: ['demands:configure'] },
  { method: 'PATCH', path: '/demands/settings/categories/:categoryId', access: 'permission', requires: ['demands:configure'] },
]
