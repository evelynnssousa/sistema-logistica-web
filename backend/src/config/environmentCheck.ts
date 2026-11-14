import { accessSync, constants, statSync } from 'node:fs'
import { graphStorageSettings } from '../attachments/graphDriveStorage.js'
import { supabaseStorageSettings } from '../attachments/supabaseStorage.js'
import { proxySecretProblem } from '../security/trustedProxy.js'
import { passwordResetPepperProblem } from '../auth/passwordRecovery.js'
import { quotaSettings, quotaSettingsProblems } from '../integrations/emailQuota.js'
import { restrictionProblems, restrictionSummary } from '../integrations/recipientAllowlist.js'
import { attachmentDirectoryProblem, projectRoot, storageDriver } from '../attachments/storage.js'

/**
 * Conferência das variáveis de ambiente, para a implantação e para o início da API. Nunca
 * devolve nem registra valores: só o nome da variável, a situação e o motivo.
 *
 *   erro   impede o uso seguro da função correspondente; em produção, corrigir antes de publicar
 *   aviso  a função fica indisponível ou incompleta, sem risco de dado exposto
 *   ok     presente e no formato esperado
 */

export type CheckLevel = 'ok' | 'aviso' | 'erro'

export type EnvironmentFinding = {
  variable: string
  level: CheckLevel
  message: string
}

type Environment = NodeJS.ProcessEnv

const value = (environment: Environment, name: string) => environment[name]?.trim() ?? ''
const isProduction = (environment: Environment) => environment.NODE_ENV === 'production'
const isHttps = (raw: string) => {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}
const emailAddress = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** O remetente do Resend pode vir como "Nome <endereco@dominio>". */
function senderAddress(raw: string) {
  const match = /<([^<>]+)>\s*$/.exec(raw)
  return (match ? match[1] : raw).trim()
}

/** 32 bytes em base64, como gera `openssl rand -base64 32`. */
export function passengerKeyProblem(raw: string | undefined): string | null {
  const encoded = raw?.trim()
  if (!encoded) return 'ausente'
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return 'não está em base64'
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) return `precisa ter 32 bytes; tem ${key.length}`
  if (key.every((byte) => byte === key[0])) return 'não pode ser um valor repetido'
  return null
}

/**
 * ATTACHMENTS_STORAGE escolhe onde ficam os anexos. "sharepoint" ou "supabase" mal configurados
 * são erro e nunca caem para o disco local: os arquivos iriam para um lugar que ninguém aprovou.
 */
function checkAttachmentStorage(environment: Environment, root: string): EnvironmentFinding[] {
  const driver = storageDriver(environment)
  if (driver === null) {
    return [{ variable: 'ATTACHMENTS_STORAGE', level: 'erro', message: 'Valor desconhecido: use "local", "supabase" ou "sharepoint". Anexos ficam indisponíveis.' }]
  }
  if (driver === 'local') return [checkAttachments(environment, root)]
  if (driver === 'supabase') return checkSupabaseStorage(environment)

  const settings = graphStorageSettings(environment)
  if (!settings.ok) {
    return settings.problems.map((problem) => ({
      variable: problem.variable,
      level: 'erro' as const,
      message: `${problem.message} Com ATTACHMENTS_STORAGE=sharepoint, anexos ficam indisponíveis.`,
    }))
  }
  const findings: EnvironmentFinding[] = [
    {
      variable: 'ATTACHMENTS_STORAGE',
      level: 'ok',
      message: 'SharePoint pelo Microsoft Graph, configuração completa. A conexão real só é comprovada em homologação.',
    },
  ]
  if (settings.value.credentials.kind === 'secret' && isProduction(environment)) {
    findings.push({
      variable: 'GRAPH_CLIENT_SECRET',
      level: 'aviso',
      message: 'Segredo do aplicativo em produção: prefira certificado e acompanhe o vencimento.',
    })
  }
  if (value(environment, 'ATTACHMENTS_DIR')) {
    findings.push({ variable: 'ATTACHMENTS_DIR', level: 'aviso', message: 'Ignorada: o armazenamento escolhido é o SharePoint.' })
  }
  return findings
}

function checkSupabaseStorage(environment: Environment): EnvironmentFinding[] {
  const settings = supabaseStorageSettings(environment)
  if (!settings.ok) {
    return settings.problems.map((problem) => ({
      variable: problem.variable,
      level: 'erro' as const,
      message: `${problem.message} Com ATTACHMENTS_STORAGE=supabase, anexos ficam indisponíveis.`,
    }))
  }
  const findings: EnvironmentFinding[] = [
    {
      variable: 'ATTACHMENTS_STORAGE',
      level: 'ok',
      message: `Supabase Storage, bucket "${settings.value.bucket}". Que ele existe e é privado só é conferido na conexão (/api/health).`,
    },
  ]
  if (value(environment, 'ATTACHMENTS_DIR')) {
    findings.push({ variable: 'ATTACHMENTS_DIR', level: 'aviso', message: 'Ignorada: o armazenamento escolhido é o Supabase Storage.' })
  }
  return findings
}

function checkAttachments(environment: Environment, root: string): EnvironmentFinding {
  const directory = value(environment, 'ATTACHMENTS_DIR')
  const problem = attachmentDirectoryProblem(directory, root)
  if (problem === 'ausente') {
    return { variable: 'ATTACHMENTS_DIR', level: 'aviso', message: 'Ausente: envio de anexos indisponível (503).' }
  }
  if (problem) return { variable: 'ATTACHMENTS_DIR', level: 'erro', message: `Inválida: ${problem}. Anexos ficam indisponíveis.` }

  try {
    const stats = statSync(directory)
    if (!stats.isDirectory()) {
      return { variable: 'ATTACHMENTS_DIR', level: 'erro', message: 'O caminho existe e não é uma pasta.' }
    }
    accessSync(directory, constants.R_OK | constants.W_OK)
    if ((stats.mode & 0o007) !== 0) {
      return {
        variable: 'ATTACHMENTS_DIR',
        level: 'aviso',
        message: 'A pasta é acessível a outros usuários da máquina. Use permissão 700.',
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        variable: 'ATTACHMENTS_DIR',
        level: 'aviso',
        message: 'A pasta ainda não existe; a API tenta criá-la com permissão 700 no primeiro uso.',
      }
    }
    return { variable: 'ATTACHMENTS_DIR', level: 'erro', message: 'Sem permissão de leitura e escrita na pasta.' }
  }
  return { variable: 'ATTACHMENTS_DIR', level: 'ok', message: 'Pasta absoluta, fora do projeto e gravável.' }
}

export function checkEnvironment(
  environment: Environment = process.env,
  root: string = projectRoot,
): EnvironmentFinding[] {
  const production = isProduction(environment)
  const findings: EnvironmentFinding[] = []
  const add = (variable: string, level: CheckLevel, message: string) => findings.push({ variable, level, message })

  add(
    'DATABASE_URL',
    value(environment, 'DATABASE_URL') ? 'ok' : 'erro',
    value(environment, 'DATABASE_URL') ? 'Presente.' : 'Ausente: a API não acessa o banco.',
  )

  const passenger = passengerKeyProblem(environment.PASSENGER_DATA_KEY)
  if (passenger === 'ausente') add('PASSENGER_DATA_KEY', 'aviso', 'Ausente: Passagens não aceita passageiros (503), e nenhum CPF é gravado.')
  else if (passenger) add('PASSENGER_DATA_KEY', 'erro', `Inválida: ${passenger}. Passagens não aceita passageiros.`)
  else add('PASSENGER_DATA_KEY', 'ok', 'Chave de 32 bytes. Confirme que há cópia segura fora do servidor e dos backups.')

  findings.push(...checkAttachmentStorage(environment, root))

  // Provedor de e-mail (14/11/2026): Resend (padrão) ou Brevo, por EMAIL_PROVIDER.
  const provider = value(environment, 'EMAIL_PROVIDER').toLowerCase() === 'brevo' ? 'brevo' : 'resend'
  const rawProvider = value(environment, 'EMAIL_PROVIDER')
  if (rawProvider && !['resend', 'brevo'].includes(rawProvider.toLowerCase())) {
    add('EMAIL_PROVIDER', 'erro', 'Valor desconhecido: use "resend" ou "brevo". Valendo o Resend.')
  }
  const keyName = provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY'
  const resendKey = value(environment, keyName)
  const resendFrom = value(environment, 'EMAIL_FROM') || value(environment, 'RESEND_FROM')
  const fromName = value(environment, 'EMAIL_FROM') ? 'EMAIL_FROM' : 'RESEND_FROM'
  if (!resendKey || !resendFrom) {
    add(provider === 'resend' ? 'RESEND_API_KEY / RESEND_FROM' : 'BREVO_API_KEY / EMAIL_FROM', 'aviso', 'Ausentes: nenhum e-mail sai, nem o de recuperação de senha.')
  } else if (!emailAddress.test(senderAddress(resendFrom))) {
    add(fromName, 'erro', 'Remetente fora do formato "endereco@dominio" ou "Nome <endereco@dominio>".')
  } else if (provider === 'resend' && !resendKey.startsWith('re_')) {
    add('RESEND_API_KEY', 'aviso', 'Não tem o prefixo das chaves do Resend ("re_"). Confira a chave.')
  } else if (provider === 'brevo' && !resendKey.startsWith('xkeysib-')) {
    add('BREVO_API_KEY', 'aviso', 'Não tem o prefixo das chaves de API do Brevo ("xkeysib-"). Confira a chave.')
  } else {
    add(
      `${keyName} / ${fromName}`,
      'ok',
      provider === 'brevo'
        ? 'Brevo: presentes. O remetente precisa estar confirmado no Brevo (Senders). O envio real só é comprovado pelo roteiro de homologação.'
        : 'Presentes. O envio real só é comprovado pelo roteiro de homologação.',
    )
  }

  // A mesma regra da API (auth/passwordRecovery.ts), sobre o valor sem espaços nas extremidades.
  const pepper = passwordResetPepperProblem(environment.PASSWORD_RESET_PEPPER)
  if (pepper === 'ausente') add('PASSWORD_RESET_PEPPER', 'aviso', 'Ausente: a recuperação de senha fica desligada.')
  else if (pepper) {
    add(
      'PASSWORD_RESET_PEPPER',
      'erro',
      production
        ? 'Curta demais: use ao menos 32 caracteres aleatórios. Em produção, a API não inicia.'
        : 'Curta demais: use ao menos 32 caracteres aleatórios. Em produção, a API não iniciaria.',
    )
  } else add('PASSWORD_RESET_PEPPER', 'ok', 'Presente.')

  if (value(environment, 'NOTIFICATION_EMAILS_ENABLED') === 'true' && (!resendKey || !resendFrom)) {
    add('NOTIFICATION_EMAILS_ENABLED', 'erro', `Ligada sem ${keyName} e o remetente: as mensagens ficam "não configuradas".`)
  }

  // Lista de destinatários de teste: só o modo e as contagens, nunca os endereços.
  for (const problem of restrictionProblems(environment)) add('EMAIL_RECIPIENT_ALLOWLIST', 'erro', problem)
  const restriction = restrictionSummary(environment)
  if (restriction.mode === 'off') {
    add('EMAIL_RECIPIENT_RESTRICTION', 'aviso', 'Desligada: os e-mails reais saem para qualquer destinatário. Só depois da homologação, com autorização.')
  } else if (restriction.allowedRecipients === 0) {
    add('EMAIL_RECIPIENT_ALLOWLIST', 'aviso', 'Modo de testes restritos sem lista: nenhum e-mail real sai, nem a recuperação de senha.')
  } else {
    add('EMAIL_RECIPIENT_ALLOWLIST', 'ok', `Modo de testes restritos: ${restriction.allowedRecipients} destinatário(s) autorizado(s).`)
  }

  // Cota diária: sem limite, a fila de um provedor real não envia; a recuperação segue sem contagem.
  for (const problem of quotaSettingsProblems(environment)) add('EMAIL_DAILY_LIMIT', 'erro', problem)
  const quota = quotaSettings(environment)
  if (quota.dailyLimit === null) {
    add(
      'EMAIL_DAILY_LIMIT',
      value(environment, 'NOTIFICATION_EMAILS_ENABLED') === 'true' ? 'erro' : 'aviso',
      'Ausente: as notificações não saem pelo provedor real, e a recuperação de senha não tem reserva diária.',
    )
  } else {
    add(
      'EMAIL_DAILY_LIMIT',
      'ok',
      `Limite de ${quota.dailyLimit} por dia (UTC), com ${quota.recoveryReserve} reservados à recuperação de senha. Confira no painel do Resend.`,
    )
  }

  // A integração com o Google Calendar foi removida em 11/11/2026: sobras no painel são ignoradas.
  const leftovers = Object.keys(environment).filter((name) => name.startsWith('GOOGLE_CALENDAR_') && value(environment, name))
  if (leftovers.length > 0) {
    add('GOOGLE_CALENDAR_*', 'aviso', `Integração removida: ${leftovers.length} variável(is) ignorada(s), que podem ser apagadas.`)
  }

  for (const simulated of ['EMAIL_TRANSPORT']) {
    if (production && value(environment, simulated) === 'simulated') {
      add(simulated, 'erro', 'Transporte simulado em produção: é ignorado, mas não deve existir.')
    }
  }

  const frontend = value(environment, 'FRONTEND_URL')
  if (production) {
    if (!frontend) add('FRONTEND_URL', 'erro', 'Ausente em produção: o CORS usaria o endereço de desenvolvimento.')
    else if (!isHttps(frontend)) add('FRONTEND_URL', 'erro', 'Em produção, precisa ser https.')
    else add('FRONTEND_URL', 'ok', 'Endereço https.')

    const publicUrl = value(environment, 'APP_PUBLIC_URL')
    if (!publicUrl) add('APP_PUBLIC_URL', 'aviso', 'Ausente: e-mails saem sem link e a recuperação usa código.')
    else if (!isHttps(publicUrl)) add('APP_PUBLIC_URL', 'erro', 'Precisa ser https; sem isso, é ignorada.')
    else add('APP_PUBLIC_URL', 'ok', 'Endereço https.')

    if (value(environment, 'COOKIE_SECURE') === 'false') {
      add('COOKIE_SECURE', 'aviso', 'Em produção o cookie é sempre Secure; o valor false é ignorado.')
    }
    if (value(environment, 'MONITORING_ENABLED') !== 'true') {
      add('MONITORING_ENABLED', 'aviso', 'Desligado: a disponibilidade não é registrada.')
    }
    if (!value(environment, 'INSTITUTIONAL_EMAIL_DOMAINS')) {
      add('INSTITUTIONAL_EMAIL_DOMAINS', 'aviso', 'Sem lista: qualquer domínio pode pedir cadastro, que continua exigindo aprovação.')
    }
    const proxySecret = proxySecretProblem(environment.PROXY_SHARED_SECRET)
    if (proxySecret === 'ausente') {
      add('PROXY_SHARED_SECRET', 'aviso', 'Ausente: a API aceita chamadas diretas, fora do proxy do Cloudflare Pages.')
    } else if (proxySecret) {
      add('PROXY_SHARED_SECRET', 'erro', `Inválida: ${proxySecret}. A API não inicia.`)
    } else {
      add('PROXY_SHARED_SECRET', 'ok', 'Presente: só o proxy do Cloudflare Pages chega às rotas, exceto /api/health.')
    }
    // O disco do Render Free é apagado a cada nova publicação ou reinício.
    if (value(environment, 'RENDER') === 'true' && storageDriver(environment) === 'local' && value(environment, 'ATTACHMENTS_DIR')) {
      add('ATTACHMENTS_STORAGE', 'erro', 'No Render, o disco local não é persistente: anexos gravados nele seriam perdidos.')
    }
    // Com o segredo do proxy, o IP vem de X-SLM-Client-IP; X-Forwarded-For não é necessário.
    if (!value(environment, 'TRUST_PROXY') && proxySecret !== null) {
      add('TRUST_PROXY', 'aviso', 'Sem valor: atrás de proxy, os limites por IP valem para o proxy inteiro.')
    }
  }

  return findings
}

export function hasBlockingProblem(findings: readonly EnvironmentFinding[]) {
  return findings.some((finding) => finding.level === 'erro')
}
