import { timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import { stdin, stdout } from 'node:process'
import {
  createPostgresAuthRepository,
  InitialAdministratorBootstrapError,
} from '../auth/postgres.repository'
import { AuthError } from '../auth/errors'
import { hashPassword } from '../auth/password'
import { normalizeDomainAllowlist, parseRegistration } from '../auth/validation'
import { pool } from '../database/pool'

type BootstrapStage =
  | 'configuracao_inicial'
  | 'leitura_dos_dados_iniciais'
  | 'leitura_da_chave'
  | 'validacao_da_chave'
  | 'leitura_da_senha'
  | 'validacao_dos_dados'
  | 'acesso_ao_banco'
  | 'criacao_do_administrador'

type RegistrationValidationReason =
  | 'cadastro_invalido'
  | 'email_invalido'
  | 'nome_invalido'
  | 'setor_invalido'
  | 'dominios_institucionais_nao_configurados'
  | 'dominio_institucional_nao_autorizado'
  | 'senha_invalida'
  | 'confirmacao_de_senha_diferente'

function getRegistrationValidationReason(error: unknown): RegistrationValidationReason | undefined {
  if (!(error instanceof AuthError)) return undefined

  switch (error.code) {
    case 'INVALID_REGISTRATION':
    case 'ROLE_NOT_ALLOWED':
      return 'cadastro_invalido'
    case 'INVALID_EMAIL':
      return 'email_invalido'
    case 'INVALID_NAME':
      return 'nome_invalido'
    case 'INVALID_SECTOR':
      return 'setor_invalido'
    case 'REGISTRATION_NOT_CONFIGURED':
      return 'dominios_institucionais_nao_configurados'
    case 'EMAIL_DOMAIN_NOT_ALLOWED':
      return 'dominio_institucional_nao_autorizado'
    case 'INVALID_PASSWORD':
      return 'senha_invalida'
    case 'PASSWORD_MISMATCH':
      return 'confirmacao_de_senha_diferente'
    default:
      return undefined
  }
}

async function readHidden(prompt: string, maskInput = false): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Execute este comando em um terminal interativo.')
  }

  stdout.write(`${prompt}: `)
  emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()

  return new Promise((resolve, reject) => {
    let value = ''
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        finish()
        reject(new Error('Operação cancelada.'))
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        stdout.write('\n')
        finish()
        resolve(value)
        return
      }
      if (key.name === 'backspace') {
        const characters = Array.from(value)
        if (characters.length > 0) {
          characters.pop()
          value = characters.join('')
          if (maskInput) stdout.write('\b \b')
        }
        return
      }
      if (character && !key.ctrl) {
        value += character
        if (maskInput) stdout.write('*'.repeat(Array.from(character).length))
      }
    }
    const finish = () => {
      stdin.off('keypress', onKeypress)
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.on('keypress', onKeypress)
  })
}

async function main(): Promise<void> {
  let stage: BootstrapStage = 'configuracao_inicial'
  let validationReason: RegistrationValidationReason | undefined
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada no ambiente.')
    const bootstrapKey = process.env.AUTH_INITIAL_ADMIN_KEY
    if (!bootstrapKey || Buffer.byteLength(bootstrapKey) < 32) {
      throw new Error('AUTH_INITIAL_ADMIN_KEY precisa ser uma chave temporária forte de ao menos 32 bytes.')
    }

    stage = 'leitura_dos_dados_iniciais'
    const prompt = createInterface({ input: stdin, output: stdout })
    let registration: ReturnType<typeof parseRegistration>
    let password: string
    try {
      const fullName = await prompt.question('Nome completo: ')
      const email = await prompt.question('E-mail institucional: ')
      const sector = await prompt.question('Setor: ')
      prompt.close()

      stage = 'leitura_da_chave'
      const enteredKey = await readHidden('Chave temporária de bootstrap', true)
      stage = 'validacao_da_chave'
      const provided = Buffer.from(enteredKey)
      const expected = Buffer.from(bootstrapKey)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new Error('Chave de bootstrap inválida.')
      }

      stage = 'leitura_da_senha'
      password = await readHidden('Senha inicial (mínimo 12 caracteres)')
      const confirmation = await readHidden('Confirme a senha')
      stage = 'validacao_dos_dados'
      try {
        registration = parseRegistration(
          { fullName, email, sector, password, passwordConfirmation: confirmation },
          normalizeDomainAllowlist(process.env.INSTITUTIONAL_EMAIL_DOMAINS),
        )
      } catch (error) {
        validationReason = getRegistrationValidationReason(error)
        throw error
      }
    } finally {
      prompt.close()
    }

    stage = 'acesso_ao_banco'
    const repository = createPostgresAuthRepository()
    if (!repository) throw new Error('Repositório PostgreSQL indisponível.')
    stage = 'criacao_do_administrador'
    await repository.createInitialAdministrator({
      ...registration,
      passwordHash: await hashPassword(password),
    })
    process.env.AUTH_INITIAL_ADMIN_KEY = ''
    stdout.write('Conta administradora inicial provisionada.\n')
  } catch (error) {
    if (error instanceof InitialAdministratorBootstrapError) {
      stage = error.stage === 'database_access' ? 'acesso_ao_banco' : 'criacao_do_administrador'
    }
    console.error(
      `Bootstrap não concluído. Verifique a configuração e o estado do banco; nenhum segredo foi registrado. (etapa: ${stage})${
        validationReason ? ` (motivo: ${validationReason})` : ''
      }`,
    )
    process.exitCode = 1
  }
}

main()
  .finally(async () => {
    await pool?.end()
  })
