import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { authAuditRetentionDays } from './authAuditRepository.js'
import { PostgresSessionStore } from './postgresSessionStore.js'
import { AccountAuthorizationError, UserRepository } from './userRepository.js'
import { withTransaction } from './withTransaction.js'

type FakeResult = {
  rows: Record<string, unknown>[]
  rowCount: number | null
}

type QueryCall = {
  text: string
  values: unknown[]
}

type Responder = (text: string, values: unknown[]) => FakeResult

const emptyResult = (): FakeResult => ({ rows: [], rowCount: 0 })

class FakeClient {
  readonly calls: QueryCall[] = []
  releaseCount = 0
  readonly releaseErrors: Array<Error | boolean | undefined> = []

  constructor(private readonly respond: Responder = () => emptyResult()) {}

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values })
    return this.respond(text, values)
  }

  release(error?: Error | boolean) {
    this.releaseCount += 1
    this.releaseErrors.push(error)
  }
}

class FakePool {
  readonly client: FakeClient
  connectCount = 0
  readonly calls: QueryCall[] = []
  private readonly respond: Responder

  constructor(respond: Responder = () => emptyResult()) {
    this.respond = respond
    this.client = new FakeClient(respond)
  }

  async connect() {
    this.connectCount += 1
    return this.client
  }

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values })
    return this.respond(text, values)
  }
}

function poolProvider(pool: FakePool) {
  return () => pool as unknown as Pool
}

const administrator: AuthenticatedIdentity = {
  userId: 'admin-id',
  role: 'administrator',
}

const validPasswordHash =
  '$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$ZGlnZXN0'

test('creates users with normalized identifiers and atomic audit', async () => {
  const pool = new FakePool((text) => {
    if (text.includes('SELECT id::text AS id')) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }
    if (text.includes('INSERT INTO app_private.users')) {
      return {
        rows: [
          {
            id: 'new-user-id',
            name: 'Operador SLM',
            email: 'operator@example.gov.br',
            username: 'operator.sml',
            role: 'slm_operator',
            is_active: true,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }
    return emptyResult()
  })

  const created = await new UserRepository(poolProvider(pool)).createUser(
    administrator,
    {
      name: ' Operador SLM ',
      email: ' Operator@Example.gov.br ',
      username: ' Operator.SML ',
      passwordHash: validPasswordHash,
      role: 'slm_operator',
    },
  )

  const insert = pool.client.calls.find((call) =>
    call.text.includes('INSERT INTO app_private.users'),
  )
  assert.equal(created.id, 'new-user-id')
  assert.deepEqual(insert?.values.slice(1, 4), [
    'operator@example.gov.br',
    'operator.sml',
    validPasswordHash,
  ])
  assert.deepEqual(
    pool.client.calls.map((call) => call.text.trim().split(/\s+/)[0]),
    ['BEGIN', 'SELECT', 'INSERT', 'INSERT', 'COMMIT'],
  )
  assert.equal(pool.client.releaseCount, 1)
})

test('rejects non-administrators before opening a database transaction', async () => {
  const pool = new FakePool()
  const operator: AuthenticatedIdentity = {
    userId: 'operator-id',
    role: 'slm_operator',
  }

  await assert.rejects(
    () =>
      new UserRepository(poolProvider(pool)).createUser(operator, {
        name: 'Another operator',
        username: 'operator-two',
        passwordHash: validPasswordHash,
        role: 'slm_operator',
      }),
    AccountAuthorizationError,
  )
  assert.equal(pool.connectCount, 0)
})

test('verifies the administrator against PostgreSQL and rolls back on audit failure', async () => {
  const pool = new FakePool((text) => {
    if (text.includes('SELECT id::text AS id, role, is_active')) {
      return {
        rows: [{ id: 'operator-id', role: 'slm_operator', is_active: true }],
        rowCount: 1,
      }
    }
    if (text.includes('SELECT id::text AS id')) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }
    if (text.includes('UPDATE app_private.users')) {
      return {
        rows: [
          {
            id: 'operator-id',
            name: 'Updated operator',
            email: null,
            username: 'operator-one',
            role: 'slm_operator',
            is_active: true,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-02T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('INSERT INTO app_private.auth_audit_events')) {
      throw new Error('database detail must not escape')
    }
    return emptyResult()
  })

  await assert.rejects(
    () =>
      new UserRepository(poolProvider(pool)).updateUser(
        administrator,
        'operator-id',
        {
          name: 'Updated operator',
          username: 'operator-one',
          role: 'slm_operator',
          isActive: true,
        },
      ),
    (error: Error) => {
      assert.equal(error.message, 'Não foi possível concluir a operação de persistência.')
      assert.doesNotMatch(error.message, /database detail/)
      assert.equal((error.cause as Error).message, 'database detail must not escape')
      return true
    },
  )

  assert.equal(pool.client.calls.some((call) => call.text === 'ROLLBACK'), true)
  assert.equal(pool.client.calls.some((call) => call.text === 'COMMIT'), false)
  assert.equal(pool.client.releaseCount, 1)
})

test('deactivation revokes sessions and reactivation cannot revive old cookies', async () => {
  let userIsActive = true
  let sessionIsRevoked = false
  const auditEvents: unknown[] = []
  const sessionId = 'session-to-revoke'
  const userId = 'operator-id'

  const pool = new FakePool((text, values) => {
    if (text.includes('SELECT id::text AS id, role, is_active')) {
      return {
        rows: [{ id: userId, role: 'slm_operator', is_active: userIsActive }],
        rowCount: 1,
      }
    }
    if (text.includes('SELECT id::text AS id')) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }
    if (text.includes('UPDATE app_private.users')) {
      userIsActive = values[5] as boolean
      return {
        rows: [
          {
            id: userId,
            name: 'Operator',
            email: null,
            username: 'operator-one',
            role: 'slm_operator',
            is_active: userIsActive,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-02T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('UPDATE app_private.auth_sessions')) {
      if (sessionIsRevoked) return emptyResult()
      sessionIsRevoked = true
      return { rows: [{ id: sessionId }], rowCount: 1 }
    }
    if (text.includes('INSERT INTO app_private.auth_audit_events')) {
      auditEvents.push(values)
      return emptyResult()
    }
    if (text.includes('SELECT s.id::text AS id')) {
      if (sessionIsRevoked || !userIsActive) return emptyResult()
      return {
        rows: [
          {
            id: sessionId,
            token_hash: 'd'.repeat(64),
            user_id: userId,
            role: 'slm_operator',
            issued_at: new Date('2026-01-01T00:00:00Z'),
            expires_at: new Date('2026-01-01T08:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }
    return emptyResult()
  })
  const users = new UserRepository(poolProvider(pool))

  await users.updateUser(administrator, userId, {
    name: 'Operator',
    username: 'operator-one',
    role: 'slm_operator',
    isActive: false,
  })
  assert.equal(sessionIsRevoked, true)
  const revocation = pool.client.calls.find((call) =>
    call.text.includes('UPDATE app_private.auth_sessions'),
  )
  assert.deepEqual(revocation?.values, [userId, administrator.userId])
  const revocationEvent = auditEvents.find(
    (event) => (event as unknown[])[5] === 'session_revoked',
  ) as unknown[] | undefined
  assert.deepEqual(revocationEvent?.slice(0, 6), [
    administrator.userId,
    'user',
    null,
    userId,
    sessionId,
    'session_revoked',
  ])

  await users.updateUser(administrator, userId, {
    name: 'Operator',
    username: 'operator-one',
    role: 'slm_operator',
    isActive: true,
  })

  const oldSession = await new PostgresSessionStore(poolProvider(pool)).findByTokenHash(
    'd'.repeat(64),
  )
  assert.equal(userIsActive, true)
  assert.equal(sessionIsRevoked, true)
  assert.equal(oldSession, null)
})

test('rolls back deactivation when a session audit event fails', async () => {
  const pool = new FakePool((text) => {
    if (text.includes('SELECT id::text AS id, role, is_active')) {
      return { rows: [{ id: 'operator-id', role: 'slm_operator', is_active: true }], rowCount: 1 }
    }
    if (text.includes('SELECT id::text AS id')) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }
    if (text.includes('UPDATE app_private.users')) {
      return {
        rows: [
          {
            id: 'operator-id',
            name: 'Operator',
            email: null,
            username: 'operator-one',
            role: 'slm_operator',
            is_active: false,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-02T00:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }
    if (text.includes('UPDATE app_private.auth_sessions')) {
      return { rows: [{ id: 'session-id' }], rowCount: 1 }
    }
    if (text.includes('INSERT INTO app_private.auth_audit_events')) {
      throw new Error('session audit failed')
    }
    return emptyResult()
  })

  await assert.rejects(
    () =>
      new UserRepository(poolProvider(pool)).updateUser(
        administrator,
        'operator-id',
        {
          name: 'Operator',
          username: 'operator-one',
          role: 'slm_operator',
          isActive: false,
        },
      ),
    (error: Error & { cause?: unknown }) => {
      assert.equal(error.message, 'Não foi possível concluir a operação de persistência.')
      assert.equal((error.cause as Error).message, 'session audit failed')
      return true
    },
  )
  assert.equal(pool.client.calls.some((call) => call.text.includes('UPDATE app_private.users')), true)
  assert.equal(pool.client.calls.some((call) => call.text.includes('UPDATE app_private.auth_sessions')), true)
  assert.equal(pool.client.calls.some((call) => call.text === 'ROLLBACK'), true)
  assert.equal(pool.client.calls.some((call) => call.text === 'COMMIT'), false)
  assert.equal(pool.client.releaseCount, 1)
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
      withTransaction(pool as unknown as Pool, async () => {
        throw originalError
      }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [originalError, rollbackError])
      assert.equal(error.cause, originalError)
      return true
    },
  )

  assert.equal(pool.client.calls.some((call) => call.text === 'ROLLBACK'), true)
  assert.deepEqual(pool.client.releaseErrors, [rollbackError])
  assert.equal(pool.client.releaseCount, 1)
})

test('loads current role only for active, unrevoked, unexpired sessions', async () => {
  const pool = new FakePool(() => ({
    rows: [
      {
        id: 'session-id',
        token_hash: 'a'.repeat(64),
        user_id: 'user-id',
        role: 'administrator',
        issued_at: new Date('2026-01-01T00:00:00Z'),
        expires_at: new Date('2026-01-01T08:00:00Z'),
      },
    ],
    rowCount: 1,
  }))

  const session = await new PostgresSessionStore(poolProvider(pool)).findByTokenHash(
    'a'.repeat(64),
  )
  const query = pool.calls[0].text

  assert.equal(session?.role, 'administrator')
  assert.equal(session?.userId, 'user-id')
  assert.match(query, /JOIN app_private\.users u ON u\.id = s\.user_id/)
  assert.match(query, /s\.revoked_at IS NULL/)
  assert.match(query, /s\.expires_at > now\(\)/)
  assert.match(query, /u\.is_active = true/)
  assert.deepEqual(pool.calls[0].values, ['a'.repeat(64)])
})

test('session save and logical revoke audit atomically with parameterized SQL', async () => {
  const pool = new FakePool((text) => {
    if (text.includes('INSERT INTO app_private.auth_sessions')) {
      return {
        rows: [{ id: 'session-id', user_id: 'user-id' }],
        rowCount: 1,
      }
    }
    if (text.includes('UPDATE app_private.auth_sessions')) {
      return {
        rows: [{ id: 'session-id', user_id: 'user-id' }],
        rowCount: 1,
      }
    }
    return emptyResult()
  })
  const store = new PostgresSessionStore(poolProvider(pool))
  const session = {
    tokenHash: 'b'.repeat(64),
    userId: 'user-id',
    role: 'slm_operator' as const,
    issuedAt: Date.parse('2026-01-01T00:00:00Z'),
    expiresAt: Date.parse('2026-01-01T08:00:00Z'),
  }

  await store.save(session)
  const savedCalls = [...pool.client.calls]
  assert.match(savedCalls[1].text, /INSERT INTO app_private\.auth_sessions/)
  assert.match(savedCalls[1].text, /FOR UPDATE/)
  assert.deepEqual(savedCalls[1].values, [
    session.tokenHash,
    session.userId,
    session.role,
    new Date(session.issuedAt),
    new Date(session.expiresAt),
  ])
  assert.match(savedCalls[2].text, /INSERT INTO app_private\.auth_audit_events/)
  assert.deepEqual(savedCalls[2].values.slice(3, 6), [
    'user-id',
    'session-id',
    'session_created',
  ])

  pool.client.calls.length = 0
  await store.deleteByTokenHash(session.tokenHash)
  const revokedCalls = pool.client.calls
  assert.match(revokedCalls[1].text, /UPDATE app_private\.auth_sessions/)
  assert.match(revokedCalls[1].text, /revoked_at = COALESCE\(revoked_at, now\(\)\)/)
  assert.doesNotMatch(revokedCalls[1].text, /DELETE FROM app_private\.auth_sessions/)
  assert.match(revokedCalls[2].text, /INSERT INTO app_private\.auth_audit_events/)
  assert.equal(revokedCalls.at(-1)?.text, 'COMMIT')
  assert.equal(pool.client.releaseCount, 2)
})

test('rolls back logical revocation if its audit insert fails', async () => {
  const pool = new FakePool((text) => {
    if (text.includes('UPDATE app_private.auth_sessions')) {
      return {
        rows: [{ id: 'session-id', user_id: 'user-id' }],
        rowCount: 1,
      }
    }
    if (text.includes('INSERT INTO app_private.auth_audit_events')) {
      throw new Error('secret database detail')
    }
    return emptyResult()
  })

  await assert.rejects(
    () => new PostgresSessionStore(poolProvider(pool)).deleteByTokenHash('c'.repeat(64)),
    (error: Error) => {
      assert.equal(error.message, 'Não foi possível concluir a operação de persistência.')
      assert.doesNotMatch(error.message, /secret database detail/)
      return true
    },
  )
  assert.equal(pool.client.calls.some((call) => call.text === 'ROLLBACK'), true)
  assert.equal(pool.client.calls.some((call) => call.text === 'COMMIT'), false)
  assert.equal(pool.client.releaseCount, 1)
})

test('declares the active-session index as non-unique and audit retention as 365 days', () => {
  const schema = readFileSync(
    resolve(process.cwd(), 'backend/database/schema/001_authentication.sql'),
    'utf8',
  )

  assert.match(schema, /CREATE SCHEMA IF NOT EXISTS app_private/)
  assert.match(schema, /CREATE TABLE app_private\.users/)
  assert.match(schema, /CREATE TABLE app_private\.auth_sessions/)
  assert.match(schema, /CREATE TABLE app_private\.auth_audit_events/)
  assert.match(schema, /REFERENCES app_private\.users/)
  assert.match(schema, /REFERENCES app_private\.auth_sessions/)
  assert.match(schema, /CREATE INDEX auth_sessions_active_user_idx/)
  assert.doesNotMatch(schema, /CREATE UNIQUE INDEX auth_sessions_active_user_idx/)
  assert.doesNotMatch(schema, /CHECK\s*\([^)]*now\(\)/is)
  assert.equal(authAuditRetentionDays, 365)
})
test('lists pending registrations only after verifying an administrator', async () => {
  const pool = new FakePool((text) => {
    if (
      text.includes('SELECT id::text AS id') &&
      text.includes("role = 'administrator'")
    ) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }

    if (
      text.includes('FROM app_private.users') &&
      text.includes("account_status = 'pending'")
    ) {
      return {
        rows: [
          {
            id: 'pending-user-id',
            name: 'Pessoa Solicitante',
            email: 'pessoa@example.gov.br',
            sector: 'CPC',
            created_at: new Date('2026-10-20T12:00:00Z'),
          },
        ],
        rowCount: 1,
      }
    }

    return emptyResult()
  })

  const registrations = await new UserRepository(
    poolProvider(pool),
  ).listPendingRegistrations(administrator)

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'pending-user-id')
  assert.equal(registrations[0].sector, 'CPC')
  assert.equal(
    pool.client.calls.some((call) => call.text === 'COMMIT'),
    true,
  )
})

test('does not allow non-administrators to list or decide pending registrations', async () => {
  const pool = new FakePool()
  const operator: AuthenticatedIdentity = {
    userId: 'operator-id',
    role: 'slm_operator',
  }
  const users = new UserRepository(poolProvider(pool))

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

test('approves a pending registration with the selected SLM operator role and audits the decision', async () => {
  const pool = new FakePool((text) => {
    if (
      text.includes('SELECT id::text AS id') &&
      text.includes("role = 'administrator'")
    ) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }

    if (
      text.includes('FROM app_private.users') &&
      text.includes('FOR UPDATE') &&
      text.includes('account_status')
    ) {
      return {
        rows: [
          {
            id: 'pending-user-id',
            role: 'requester',
            account_status: 'pending',
          },
        ],
        rowCount: 1,
      }
    }

    if (text.includes('UPDATE app_private.users')) {
      return {
        rows: [{ id: 'pending-user-id', role: 'slm_operator' }],
        rowCount: 1,
      }
    }

    return emptyResult()
  })

  const result = await new UserRepository(
    poolProvider(pool),
  ).decidePendingRegistration(administrator, 'pending-user-id', {
    action: 'approve',
    role: 'slm_operator',
  })

  assert.equal(result.id, 'pending-user-id')
  assert.equal(result.status, 'approved')
  assert.equal(result.role, 'slm_operator')

  const calls = pool.client.calls
  assert.equal(
    calls.some(
      (call) =>
        call.text.includes('INSERT INTO app_private.auth_audit_events') &&
        call.values[5] === 'registration_approved',
    ),
    true,
  )
  assert.equal(calls.some((call) => call.text === 'COMMIT'), true)
  assert.equal(pool.client.releaseCount, 1)
})

test('rejects a pending registration and records an audit event', async () => {
  const pool = new FakePool((text) => {
    if (
      text.includes('SELECT id::text AS id') &&
      text.includes("role = 'administrator'")
    ) {
      return { rows: [{ id: administrator.userId }], rowCount: 1 }
    }

    if (
      text.includes('FROM app_private.users') &&
      text.includes('FOR UPDATE') &&
      text.includes('account_status')
    ) {
      return {
        rows: [
          {
            id: 'pending-user-id',
            role: 'requester',
            account_status: 'pending',
          },
        ],
        rowCount: 1,
      }
    }

    if (text.includes('UPDATE app_private.users')) {
      return {
        rows: [{ id: 'pending-user-id', role: 'requester' }],
        rowCount: 1,
      }
    }

    return emptyResult()
  })

  const result = await new UserRepository(
    poolProvider(pool),
  ).decidePendingRegistration(administrator, 'pending-user-id', {
    action: 'reject',
  })

  assert.equal(result.id, 'pending-user-id')
  assert.equal(result.status, 'rejected')

  assert.equal(
    pool.client.calls.some(
      (call) =>
        call.text.includes('INSERT INTO app_private.auth_audit_events') &&
        call.values[5] === 'registration_rejected',
    ),
    true,
  )
  assert.equal(pool.client.calls.some((call) => call.text === 'COMMIT'), true)
  assert.equal(pool.client.releaseCount, 1)
})
