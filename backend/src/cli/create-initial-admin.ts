import '../loadEnvironment.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getDatabasePool } from '../database/pool.js'
import { hashPassword } from '../auth/password.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { readHiddenPassword } from './readHiddenPassword.js'

async function main() {
  const terminal = createInterface({ input: stdin, output: stdout })
  const pool = getDatabasePool()

  try {
    console.log('\n=== ADMINISTRADOR INICIAL ===\n')

    const name = (await terminal.question('Nome completo: ')).trim()
    const email = (await terminal.question('E-mail institucional: '))
      .trim()
      .toLowerCase()
    const sector = (await terminal.question('Setor: ')).trim()

    // Fecha o readline antes de ativar a leitura segura da senha.
    terminal.close()

    // A senha não é exibida durante a digitação.
    const password = await readHiddenPassword('Senha (mínimo 12 caracteres): ')
    const confirmation = await readHiddenPassword('Confirme a senha: ')

    if (name.length < 2 || name.length > 120) {
      throw new Error('Nome inválido.')
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('E-mail inválido.')
    }

    if (sector.length < 2 || sector.length > 120) {
      throw new Error('Setor inválido.')
    }

    if (password.length < 12 || password.length > 512) {
      throw new Error('A senha deve ter entre 12 e 512 caracteres.')
    }

    if (password !== confirmation) {
      throw new Error('As senhas não coincidem.')
    }

    const passwordHash = await hashPassword(password)
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await client.query(
        'LOCK TABLE public.auth_users IN EXCLUSIVE MODE',
      )

      // Só cria a primeira conta; os demais administradores são aprovados pelo sistema.
      const existing = await client.query(
        `SELECT id FROM public.auth_users
          WHERE role = 'admin' AND status = 'approved'
          LIMIT 1`,
      )

      if (existing.rowCount) {
        throw new Error(
          'Já existe um administrador ativo. Nenhuma conta foi criada.',
        )
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO public.auth_users
          (full_name, email, sector, password_hash, status, role, permissions, decided_at)
         VALUES ($1, $2, $3, $4, 'approved', 'admin', '{}', now())
         RETURNING id::text AS id`,
        [name, email, sector, passwordHash],
      )

      // Depois da migração 003, o administrador também tem sua linha de acesso.
      const accessTable = await client.query<{ present: boolean }>(
        `SELECT to_regclass('public.auth_user_access') IS NOT NULL AS present`,
      )
      if (accessTable.rows[0]?.present) {
        await client.query(
          `INSERT INTO public.auth_user_access (user_id, profile) VALUES ($1, 'administrator')`,
          [created.rows[0].id],
        )
      }

      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'system',
        subjectUserId: created.rows[0].id,
        sessionId: null,
        eventType: 'initial_administrator_created',
      })

      await client.query('COMMIT')

      console.log('\nAdministrador criado com sucesso.')
      console.log(`ID: ${created.rows[0].id}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    terminal.close()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(
    'Falha ao criar o administrador:',
    error instanceof Error ? error.message : 'Erro desconhecido',
  )
  process.exitCode = 1
})
