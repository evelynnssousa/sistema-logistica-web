import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { insertAuthAuditEvent } from './authAuditRepository.js'
import { AccountAuthorizationError, UserRepository } from './userRepository.js'
import { DomainError, withTransaction } from './withTransaction.js'

// O comportamento contra o banco é coberto por publicSchemaIntegration.test.ts.
// Aqui ficam as regras que não dependem de um PostgreSQL.

type QueryCall = { text: string; values: unknown[] }
type FakeResult = { rows: Record<string, unknown>[]; rowCount: number }
type Responder = (text: string) => FakeResult

const emptyResult = (): FakeResult => ({ rows: [], rowCount: 0 })

class FakeClient {
  readonly calls: QueryCall[] = []
  releaseCount = 0
  readonly releaseErrors: Array<Error | boolean | undefined> = []

  constructor(private readonly respond: Responder) {}

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values })
    return this.respond(text)
  }

  release(error?: Error | boolean) {
    this.releaseCount += 1
    this.releaseErrors.push(error)
  }
}

class FakePool {
  readonly client: FakeClient
  connectCount = 0

  constructor(respond: Responder = emptyResult) {
    this.client = new FakeClient(respond)
  }

  async connect() {
    this.connectCount += 1
    return this.client
  }
}

const asPool = (pool: FakePool) => pool as unknown as Pool

const operator: AuthenticatedIdentity = {
  userId: 'operator-id',
  role: 'slm_operator',
  permissions: [],
  slmMember: false,
  sector: 'CPC',
}

test('rejects non-administrators before opening a database transaction', async () => {
  const pool = new FakePool()
  const users = new UserRepository(() => asPool(pool))

  await assert.rejects(
    () => users.listPendingRegistrations(operator),
    AccountAuthorizationError,
  )
  await assert.rejects(
    () =>
      users.decidePendingRegistration(operator, 'pending-user-id', {
        action: 'reject',
      }),
    AccountAuthorizationError,
  )

  assert.equal(pool.connectCount, 0)
})

test('hides database details behind a generic error and rolls back', async () => {
  const pool = new FakePool()

  await assert.rejects(
    () =>
      withTransaction(asPool(pool), async () => {
        throw new Error('secret database detail')
      }),
    (error: Error) => {
      assert.equal(error.message, 'Não foi possível concluir a operação de persistência.')
      assert.equal((error.cause as Error).message, 'secret database detail')
      return true
    },
  )

  assert.deepEqual(pool.client.calls.map((call) => call.text), ['BEGIN', 'ROLLBACK'])
  assert.equal(pool.client.releaseCount, 1)
})

test('keeps the message of business rule errors and still rolls back', async () => {
  const pool = new FakePool()

  await assert.rejects(
    () =>
      withTransaction(asPool(pool), async () => {
        throw new DomainError('Solicitação não encontrada.')
      }),
    (error: Error) => {
      assert.ok(error instanceof DomainError)
      assert.equal(error.message, 'Solicitação não encontrada.')
      return true
    },
  )

  assert.deepEqual(pool.client.calls.map((call) => call.text), ['BEGIN', 'ROLLBACK'])
})

test('preserves the original error and destroys the client when rollback fails', async () => {
  const originalError = new Error('operation failed')
  const rollbackError = new Error('rollback failed')
  const pool = new FakePool((text) => {
    if (text === 'ROLLBACK') throw rollbackError
    return emptyResult()
  })

  await assert.rejects(
    () =>
      withTransaction(asPool(pool), async () => {
        throw originalError
      }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [originalError, rollbackError])
      assert.equal(error.cause, originalError)
      return true
    },
  )

  assert.deepEqual(pool.client.releaseErrors, [rollbackError])
  assert.equal(pool.client.releaseCount, 1)
})

test('writes audit events in the format of the real audit table', async () => {
  const pool = new FakePool()
  const client = await pool.connect()

  await insertAuthAuditEvent(client as never, {
    actorUserId: 'admin-id',
    actorKind: 'user',
    subjectUserId: 'user-id',
    sessionId: 'session-id',
    eventType: 'session_created',
    details: { origin: 'test' },
  })

  const [call] = pool.client.calls
  assert.match(call.text, /INSERT INTO public\.auth_audit_events/)
  assert.deepEqual(call.values.slice(0, 4), [
    'admin-id',
    'auth.login',
    'user-id',
    'session-id',
  ])
  assert.deepEqual(JSON.parse(call.values[4] as string), {
    origin: 'test',
    actorKind: 'user',
  })
})

test('records the result of audit events, success by default', async () => {
  const pool = new FakePool()
  const client = await pool.connect()
  const event = {
    actorUserId: null,
    actorKind: 'system' as const,
    subjectUserId: null,
    sessionId: null,
  }

  await insertAuthAuditEvent(client as never, { ...event, eventType: 'session_created' })
  await insertAuthAuditEvent(client as never, {
    ...event,
    eventType: 'login_failed',
    result: 'failure',
  })

  assert.equal(pool.client.calls[0].values[5], 'success')
  assert.equal(pool.client.calls[1].values[1], 'auth.login_failed')
  assert.equal(pool.client.calls[1].values[5], 'failure')
})
