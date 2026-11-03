
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getDatabasePool } from '../database/pool.js'
import { hashPassword } from '../auth/password.js'
import { insertAuthAuditEvent } from '../database/authAuditRepository.js'

async function main() {
  const terminal = createInterface({ input: stdin, output: stdout })
  const pool = getDatabasePool()

  try {
    console.log('\n=== ADMINISTRADOR INICIAL ===\n')

    const name = (await terminal.question('Nome completo: ')).trim()
    const email = (await terminal.question('E-mail institucional: '))
      .trim()
      .toLowerCase()
    const username = (await terminal.question('Usuário para login: '))
      .trim()
      .toLowerCase()

    // Fecha o readline antes de ativar a leitura segura da senha.
    terminal.close()

    // A senha não é exibida durante a digitação.
    const password = await hiddenPassword('Senha (mínimo 12 caracteres): ')
    const confirmation = await hiddenPassword('Confirme a senha: ')

    if (name.length < 2 || name.length > 160) {
      throw new Error('Nome inválido.')
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('E-mail inválido.')
    }

    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
      throw new Error('Nome de usuário inválido.')
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
        'LOCK TABLE app_private.users IN EXCLUSIVE MODE',
      )

      const existing = await client.query(
        `SELECT id FROM app_private.users
          WHERE role = 'administrator' AND is_active = true
          LIMIT 1`,
      )

      if (existing.rowCount) {
        throw new Error(
          'Já existe um administrador ativo. Nenhuma conta foi criada.',
        )
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO app_private.users
          (name, email, username, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, 'administrator', true)
         RETURNING id::text AS id`,
        [name, email, username, passwordHash],
      )

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

async function hiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Execute em um terminal interativo para digitar a senha com segurança.',
    )
  }

  stdout.write(prompt)

  let resolvePassword!: (value: string) => void
  const promise = new Promise<string>((resolve) => {
    resolvePassword = resolve
  })
  let value = ''

  const onData = (chunk: Buffer) => {
    for (const character of chunk.toString()) {
      if (character === '\r' || character === '\n') {
        stdin.off('data', onData)
        stdin.setRawMode(false)
        stdin.pause()
        stdout.write('\n')
        resolvePassword(value)
      } else if (character === '\u0003') {
        stdin.off('data', onData)
        stdin.setRawMode(false)
        stdin.pause()
        resolvePassword('')
      } else if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1)
      } else {
        value += character
      }
    }
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('data', onData)

  return promise
}
