import { RequestValidationError } from './validation.js'

/**
 * Parâmetros administrativos (13/11/2026): domínios do cadastro, feriados, aviso geral, módulos,
 * padrões de atas e contratos, textos das telas e permissões padrão dos perfis. Gravados em
 * system_settings, como os demais; nenhum exige migração.
 */

export const systemModules = ['maintenance', 'fleet', 'flights', 'warehouse', 'demands'] as const
export type SystemModule = (typeof systemModules)[number]

/**
 * Permissões que o administrador pode acrescentar ou retirar do padrão de um perfil. Só as comuns
 * de cada módulo: nada de administração, configuração, auditoria, CPF, Central da SLM ou
 * agendamento, que seguem por concessão individual e com as regras de elegibilidade.
 */
export const adjustablePermissions = [
  'requests:create', 'requests:read_own', 'requests:read_all', 'requests:update', 'requests:cancel', 'requests:cancel_own',
  'maintenance:read', 'maintenance:create', 'maintenance:update',
  'fleet:read', 'fleet:create', 'fleet:update',
  'flights:read', 'flights:create', 'flights:update',
  'warehouse:read', 'reports:read', 'calendar:read', 'communications:read', 'communications:send',
] as const

export const adjustableProfiles = ['requester', 'slm_operator'] as const
export type AdjustableProfile = (typeof adjustableProfiles)[number]
export type ProfileAdjustments = Record<AdjustableProfile, { add: string[]; remove: string[] }>

export const defaultAdminSettings = {
  // Vazia: vale a variável INSTITUTIONAL_EMAIL_DOMAINS do servidor (e, sem ela, qualquer domínio).
  registration: { allowedDomains: [] as string[] },
  holidays: { list: [] as { date: string; name: string }[] },
  announcement: { active: false, text: '', tone: 'info' as 'info' | 'warning', until: null as string | null },
  modules: { maintenance: true, fleet: true, flights: true, warehouse: true, demands: true } as Record<SystemModule, boolean>,
  contracts: { defaultNoticeDays: 90, lowBalancePercent: 20 },
  texts: { loginMessage: '', homeMessage: '' },
  profileDefaults: {
    requester: { add: [], remove: [] },
    slm_operator: { add: [], remove: [] },
  } as ProfileAdjustments,
}

export type AdminSettings = typeof defaultAdminSettings
export type AdminSettingsSection = keyof AdminSettings

export function isAdminSettingsSection(value: string): value is AdminSettingsSection {
  return Object.prototype.hasOwnProperty.call(defaultAdminSettings, value)
}


/** AAAA-MM-DD que existe no calendário (recusa 30/02 e 13/2026). */
function isCalendarDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function fail(message: string): never {
  throw new RequestValidationError(message)
}

function text(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(`${label} inválido.`)
  const clean = value.trim()
  if (clean.length > max) fail(`${label} deve ter no máximo ${max} caracteres.`)
  // Vai para a tela como texto; marcação nunca é aceita.
  if (/[<>]/.test(clean)) fail(`${label} não pode conter os caracteres < >.`)
  return clean
}

function day(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDay(value)) {
    fail(`${label} inválida.`)
  }
  return value
}

function integer(value: unknown, label: string, min: number, max: number) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) fail(`${label} deve ficar entre ${min} e ${max}.`)
  return number
}

const domainPattern = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function validateAdminSettings(section: AdminSettingsSection, body: Record<string, unknown>): AdminSettings[AdminSettingsSection] {
  if (section === 'registration') {
    const list = Array.isArray(body.allowedDomains) ? body.allowedDomains : []
    if (list.length > 30) fail('Informe no máximo 30 domínios.')
    const domains = list.map((item) => String(item ?? '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    for (const domain of domains) if (!domainPattern.test(domain)) fail(`"${domain}" não é um domínio válido (exemplo: jucesp.sp.gov.br).`)
    return { allowedDomains: [...new Set(domains)] }
  }

  if (section === 'holidays') {
    const list = Array.isArray(body.list) ? body.list : []
    if (list.length > 200) fail('Informe no máximo 200 feriados.')
    const holidays = list.map((raw) => {
      const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
      const name = text(item.name, 'O nome do feriado', 120)
      if (!name) fail('Informe o nome de cada feriado.')
      return { date: day(item.date, 'A data do feriado'), name }
    })
    if (new Set(holidays.map((item) => item.date)).size !== holidays.length) fail('Há feriados repetidos na mesma data.')
    return { list: holidays.sort((a, b) => a.date.localeCompare(b.date)) }
  }

  if (section === 'announcement') {
    const active = body.active === true
    const message = text(body.text, 'O texto do aviso', 500)
    if (active && message.length < 3) fail('Escreva o texto do aviso.')
    return {
      active,
      text: message,
      tone: body.tone === 'warning' ? 'warning' : 'info',
      until: body.until === null || body.until === undefined || body.until === '' ? null : day(body.until, 'A data final do aviso'),
    }
  }

  if (section === 'modules') {
    const modules = Object.fromEntries(systemModules.map((key) => [key, body[key] !== false])) as Record<SystemModule, boolean>
    return modules
  }

  if (section === 'contracts') {
    return {
      defaultNoticeDays: integer(body.defaultNoticeDays, 'O aviso padrão de vencimento', 0, 365),
      lowBalancePercent: integer(body.lowBalancePercent, 'O percentual de saldo baixo', 0, 100),
    }
  }

  if (section === 'texts') {
    return {
      loginMessage: text(body.loginMessage, 'A mensagem da tela de entrada', 600),
      homeMessage: text(body.homeMessage, 'A mensagem da página inicial', 600),
    }
  }

  // profileDefaults
  const allowed = new Set<string>(adjustablePermissions)
  return Object.fromEntries(
    adjustableProfiles.map((profile) => {
      const entry = (typeof body[profile] === 'object' && body[profile] !== null ? body[profile] : {}) as Record<string, unknown>
      const read = (value: unknown, label: string) => {
        const list = Array.isArray(value) ? value.map(String) : []
        const invalid = list.find((item) => !allowed.has(item))
        if (invalid) fail(`A permissão ${label} "${invalid}" não pode ser ajustada pelo padrão do perfil.`)
        return [...new Set(list)]
      }
      const add = read(entry.add, 'acrescentada')
      const remove = read(entry.remove, 'retirada')
      if (add.some((item) => remove.includes(item))) fail('Uma permissão não pode ser acrescentada e retirada ao mesmo tempo.')
      return [profile, { add, remove }]
    }),
  ) as ProfileAdjustments
}

/** Aviso geral em vigor na data (AAAA-MM-DD), ou nulo. */
export function activeAnnouncement(announcement: AdminSettings['announcement'], today: string) {
  if (!announcement.active || !announcement.text) return null
  if (announcement.until && today > announcement.until) return null
  return { text: announcement.text, tone: announcement.tone, until: announcement.until }
}

/** Domínios aceitos no cadastro: os da tela, ou os da variável do servidor quando a tela está vazia. */
export function registrationDomains(configured: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  if (configured.length > 0) return [...configured]
  return (environment.INSTITUTIONAL_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

/** O prazo que cai em feriado passa para o próximo dia que não é feriado. */
export function skipHolidays(date: Date, holidays: readonly string[]) {
  const set = new Set(holidays)
  let current = date
  for (let guard = 0; guard < 30; guard += 1) {
    const key = current.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    if (!set.has(key)) return current
    current = new Date(current.getTime() + 86_400_000)
  }
  return current
}
