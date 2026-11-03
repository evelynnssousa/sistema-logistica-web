
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getDatabasePool } from '../database/pool.js'
import { hashPassword } from '../auth/password.js'

const adminId = 'cadc056e-eb7c-41b5-b88c-eef75192ade3'

async function readHiddenPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Execute em um terminal interativo.')
  }

  stdout.write(prompt)

  return new Promise((resolve, reject) => {
    let value = ''

    const cleanup = () => {
      stdin.off('data', onData)
      if (stdin.isRaw) stdin.setRawMode(false)
      stdin.pause()
    }

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('Operação cancelada.'))
          return
        }

        if (character === '\r' || character === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }

        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function main() {
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
    const result = await pool.query(
      `UPDATE public.auth_users
          SET password_hash = $1,
              updated_at = now()
        WHERE id = $2
          AND status = 'approved'
          AND role = 'admin'
        RETURNING id`,
      [passwordHash, adminId],
    )

    if (result.rowCount !== 1) {
      throw new Error(
        'Nenhuma senha foi alterada: a conta não foi encontrada ou não está aprovada como admin.',
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

