import type { Response } from 'express'
import { CpfProtectionUnavailableError } from '../requests/cpfProtection.js'
import { RequestValidationError } from '../requests/validation.js'
import { recordTechnicalEvent } from '../monitoring/technicalEvents.js'
import { logSecurityEvent } from '../security/logger.js'
import { DomainError } from './withTransaction.js'

/** Regra de negócio com status HTTP próprio. Atravessa a transação com a mensagem intacta. */
export class ModuleError extends DomainError {
  constructor(
    message: string,
    readonly status: number,
    /** Para a tela reagir a este caso, sem depender do texto. */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ModuleError'
  }
}

/** Conflito de agenda: a pessoa vê os compromissos e decide se confirma mesmo assim. */
export class ScheduleConflictError extends ModuleError {
  constructor(readonly conflicts: readonly ScheduleConflict[]) {
    super('Há compromissos no mesmo horário. Confira e confirme para agendar mesmo assim.', 409)
    this.name = 'ScheduleConflictError'
  }
}

export type ScheduleConflict = {
  id: string
  protocol: string
  module: 'maintenance' | 'fleet'
  reason: 'responsible' | 'vehicle' | 'driver'
  start: Date
  end: Date | null
}

export const notFound = () => new ModuleError('Recurso não encontrado.', 404)
export const forbidden = () => new ModuleError('Acesso não autorizado.', 403)
export const conflict = (message: string) => new ModuleError(message, 409)

function databaseCode(error: unknown): string | undefined {
  const candidates = [error, error instanceof Error ? error.cause : undefined]
  for (const candidate of candidates) {
    const code = (candidate as { code?: unknown } | undefined)?.code
    if (typeof code === 'string') return code
  }
  return undefined
}

// Tabela ou coluna inexistente: a migração 005 ainda não foi aplicada neste banco.
const missingSchemaCodes = new Set(['42P01', '42703'])

/** Resposta única de erro dos módulos. Detalhes do banco ficam só no log. */
export function sendModuleError(response: Response, error: unknown) {
  if (error instanceof RequestValidationError) {
    response.status(400).json({ success: false, message: error.message })
    return
  }
  if (error instanceof ScheduleConflictError) {
    response.status(error.status).json({
      success: false,
      code: 'SCHEDULE_CONFLICT',
      message: error.message,
      conflicts: error.conflicts,
    })
    return
  }
  if (error instanceof ModuleError) {
    response.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) })
    return
  }
  if (error instanceof CpfProtectionUnavailableError) {
    logSecurityEvent('passenger_data_key_missing')
    response.status(503).json({
      success: false,
      code: 'CPF_PROTECTION_UNAVAILABLE',
      message:
        'O cadastro de passageiros está indisponível até a configuração da proteção dos dados.',
    })
    return
  }

  const code = databaseCode(error)
  if (code && missingSchemaCodes.has(code)) {
    response.status(503).json({
      success: false,
      code: 'MODULES_MIGRATION_REQUIRED',
      message: 'Este módulo depende de uma atualização do banco de dados ainda não aplicada.',
    })
    return
  }
  if (code === '23505') {
    response.status(409).json({
      success: false,
      message: 'Já existe um registro com esses dados.',
    })
    return
  }

  recordTechnicalEvent('api', 'module_operation_failed', error)
  response.status(503).json({
    success: false,
    message: 'Não foi possível concluir a operação neste momento.',
  })
}
