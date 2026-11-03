import type { Pool, PoolClient } from 'pg'

export type TransactionPool = Pick<Pool, 'connect'>

/**
 * Erro de regra de negócio com mensagem segura para o usuário. Atravessa a
 * transação sem ser substituído pela mensagem genérica de persistência.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

export async function withTransaction<Result>(
  pool: TransactionPool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  let client: PoolClient | undefined
  let transactionStarted = false
  let destroyClientWith: Error | boolean | undefined

  try {
    client = await pool.connect()
    await client.query('BEGIN')
    transactionStarted = true

    const result = await operation(client)
    await client.query('COMMIT')
    transactionStarted = false
    return result
  } catch (originalError) {
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        destroyClientWith =
          rollbackError instanceof Error ? rollbackError : true
        throw new AggregateError(
          [originalError, rollbackError],
          'A operação falhou e o rollback também falhou.',
          { cause: originalError },
        )
      }
    }
    if (originalError instanceof DomainError) throw originalError
    throw new Error('Não foi possível concluir a operação de persistência.', {
      cause: originalError,
    })
  } finally {
    client?.release(destroyClientWith)
  }
}
