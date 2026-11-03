import '../loadEnvironment.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getDatabasePool } from '../database/pool.js'
import { hashPassword } from '../auth/password.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'
import { withTransaction } from '../database/withTransaction.js'
import { readHiddenPassword } from './readHiddenPassword.js'

async function main() {
  const terminal = createInterface({ input: stdin, output: stdout })
  const email = (await terminal.question('E-mail do administrador: '))
    .trim()
    .toLowerCase()
  terminal.close()

  const password = await readHiddenPassword('Nova senha (mínimo 12 caracteres): ')
  const confirmation = await readHiddenPassword('Confirme a nova senha: ')

  if (password.length < 12 || password.length > 512) {
    throw new Error('A senha deve ter entre 12 e 512 caracteres.')
  }

  if (password !== confirmation) {
    throw new Error('As senhas não coincidem.')
  }

  const passwordHash = await hashPassword(password)
  const pool = getDatabasePool()

  try {
    const changed = await withTransaction(pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE public.auth_users
            SET password_hash = $1,
                updated_at = now()
          WHERE lower(email) = $2
            AND status = 'approved'
            AND role = 'admin'
          RETURNING id::text AS id`,
        [passwordHash, email],
      )
      const account = result.rows[0]
      if (!account) return false

      // A troca de senha encerra as sessões abertas dessa conta.
      await client.query('DELETE FROM public.auth_sessions WHERE user_id = $1', [
        account.id,
      ])
      await insertAuthAuditEvent(client, {
        actorUserId: null,
        actorKind: 'emergency_operator',
        actorReference: 'cli:reset-initial-admin-password',
        subjectUserId: account.id,
        sessionId: null,
        eventType: 'administrator_recovered',
      })
      return true
    })

    if (!changed) {
      throw new Error(
        'Nenhuma senha foi alterada: não há administrador aprovado com esse e-mail.',
      )
    }

    console.log('Senha administrativa atualizada com sucesso.')
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(
    'Falha ao atualizar a senha:',
    error instanceof Error ? error.message : 'Erro desconhecido',
  )
  process.exitCode = 1
})
