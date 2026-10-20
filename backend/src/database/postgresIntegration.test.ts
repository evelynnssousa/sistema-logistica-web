import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { authRoles } from '../auth/roles.js'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { SessionService } from '../auth/session.js'
import { PostgresSessionStore } from './postgresSessionStore.js'
import { UserRepository } from './userRepository.js'
import { withTransaction } from './withTransaction.js'
import {
  assertDisposablePostgresContainer,
  resolvePostgresTestConnection,
  verifyPostgresTestIdentity,
} from './postgresTestGuard.js'

const testRoleNames = [
  'app_private_owner',
  'app_backend',
  'anon',
  'authenticated',
] as const
type TestRole = (typeof testRoleNames)[number]

const integrationOnlyPasswordHash = '$argon2id$integration-only-test-hash'

class RoleScopedPool {
  private readonly pendingReleases = new Set<Promise<void>>()

  constructor(
    private readonly rootPool: Pool,
    private readonly role: TestRole,
  ) {}

  async connect(): Promise<PoolClient> {
    const client = await this.rootPool.connect()
    try {
      await client.query(`SET ROLE ${this.role}`)
    } catch (error) {
      client.release(error instanceof Error ? error : true)
      throw error
    }

    const scopedClient = {
      query: client.query.bind(client),
      release: (error?: Error | boolean) => {
        if (error) {
          client.release(error)
          return
        }
        let pendingRelease: Promise<void>
        pendingRelease = client
          .query('RESET ROLE')
          .then(() => client.release())
          .catch(() => client.release(true))
          .finally(() => this.pendingReleases.delete(pendingRelease))
        this.pendingReleases.add(pendingRelease)
      },
    }
    return scopedClient as unknown as PoolClient
  }

  async query(text: string, values?: unknown[]) {
    const client = await this.connect()
    try {
      return await client.query(text, values)
    } finally {
      client.release()
      await this.drain()
    }
  }

  async drain() {
    await Promise.all([...this.pendingReleases])
  }
}

let rootPool: Pool | undefined
let ownerPool: RoleScopedPool
let backendPool: RoleScopedPool
let anonymousPool: RoleScopedPool
let authenticatedPool: RoleScopedPool
let administrator: AuthenticatedIdentity

function getRootPool(): Pool {
  if (!rootPool) throw new Error('Setup PostgreSQL de integração não executado.')
  return rootPool
}

function asPool(rolePool: RoleScopedPool): Pool {
  return rolePool as unknown as Pool
}

async function verifyPreparedRolesAndSecurity() {
  const pool = getRootPool()
  const rolesResult = await pool.query<{
    rolname: string
    rolsuper: boolean
    rolbypassrls: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    rolcanlogin: boolean
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [testRoleNames],
  )
  const roles = new Map(rolesResult.rows.map((row) => [row.rolname, row]))
  for (const roleName of testRoleNames) {
    const role = roles.get(roleName)
    assert.ok(role, `Papel de teste ausente: ${roleName}`)
    assert.equal(role.rolsuper, false, `${roleName} não deve ser superuser`)
    assert.equal(role.rolbypassrls, false, `${roleName} não deve ignorar RLS`)
    assert.equal(role.rolcreatedb, false, `${roleName} não deve criar bancos`)
    assert.equal(role.rolcreaterole, false, `${roleName} não deve criar papéis`)
    assert.equal(
      role.rolcanlogin,
      roleName === 'app_backend',
      `${roleName} possui LOGIN/NOLOGIN inesperado`,
    )
  }

  const schemaOwner = await pool.query<{ owner: string }>(
    `SELECT nspowner::regrole::text AS owner
       FROM pg_namespace
      WHERE nspname = 'app_private'`,
  )
  assert.equal(schemaOwner.rows[0]?.owner, 'app_private_owner')

  const tableOwners = await pool.query<{ table_name: string; owner: string }>(
    `SELECT c.relname AS table_name, c.relowner::regrole::text AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app_private'
        AND c.relname = ANY($1::text[])
        AND c.relkind = 'r'`,
    [['users', 'auth_sessions', 'auth_audit_events']],
  )
  assert.equal(tableOwners.rowCount, 3)
  assert.ok(tableOwners.rows.every((row) => row.owner === 'app_private_owner'))

  const tables = await pool.query<{
    relname: string
    relrowsecurity: boolean
    relforcerowsecurity: boolean
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app_private'
        AND c.relname = ANY($1::text[])
        AND c.relkind = 'r'`,
    [['users', 'auth_sessions', 'auth_audit_events']],
  )
  assert.equal(tables.rowCount, 3)
  for (const table of tables.rows) {
    assert.equal(table.relrowsecurity, true, `${table.relname} precisa de RLS`)
    assert.equal(
      table.relforcerowsecurity,
      true,
      `${table.relname} precisa forçar RLS`,
    )
  }

  const policies = await pool.query<{
    tablename: string
    policyname: string
    permissive: string
    roles: string[]
    cmd: string
    qual: string | null
    with_check: string | null
  }>(
    `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'app_private'`,
  )
  assert.ok(policies.rows.length > 0, 'Políticas RLS de teste ausentes')
  assert.ok(
    policies.rows.every((policy) =>
      policy.roles.every(
        (role) => role === 'app_backend',
      ),
    ),
    'Política RLS não deve incluir PUBLIC, anon ou authenticated',
  )
  const requiredPolicyCommands = [
    ['users', 'SELECT'],
    ['users', 'INSERT'],
    ['users', 'UPDATE'],
    ['auth_sessions', 'SELECT'],
    ['auth_sessions', 'INSERT'],
    ['auth_sessions', 'UPDATE'],
    ['auth_audit_events', 'INSERT'],
  ] as const
  for (const [tableName, command] of requiredPolicyCommands) {
    assert.ok(
      policies.rows.some(
        (policy) =>
          policy.tablename === tableName &&
          policy.roles.includes('app_backend') &&
          (policy.cmd === command || policy.cmd === 'ALL'),
      ),
      `Política RLS app_backend ausente: ${tableName}/${command}`,
    )
  }

  const privileges = await pool.query<{
    role_name: string
    schema_usage: boolean
    schema_create: boolean
    users_select: boolean
    users_insert: boolean
    users_update: boolean
    users_delete: boolean
    users_truncate: boolean
    sessions_select: boolean
    sessions_insert: boolean
    sessions_update: boolean
    sessions_delete: boolean
    sessions_truncate: boolean
    audit_select: boolean
    audit_insert: boolean
    audit_update: boolean
    audit_delete: boolean
        audit_truncate: boolean
  }>(
    `SELECT $1::text AS role_name,
            has_schema_privilege($1, 'app_private', 'USAGE') AS schema_usage,
          has_schema_privilege($1, 'app_private', 'CREATE') AS schema_create,
            has_table_privilege($1, 'app_private.users', 'SELECT') AS users_select,
            has_table_privilege($1, 'app_private.users', 'INSERT') AS users_insert,
            has_table_privilege($1, 'app_private.users', 'UPDATE') AS users_update,
            has_table_privilege($1, 'app_private.users', 'DELETE') AS users_delete,
            has_table_privilege($1, 'app_private.users', 'TRUNCATE') AS users_truncate,
            has_table_privilege($1, 'app_private.auth_sessions', 'SELECT') AS sessions_select,
            has_table_privilege($1, 'app_private.auth_sessions', 'INSERT') AS sessions_insert,
            has_table_privilege($1, 'app_private.auth_sessions', 'UPDATE') AS sessions_update,
            has_table_privilege($1, 'app_private.auth_sessions', 'DELETE') AS sessions_delete,
            has_table_privilege($1, 'app_private.auth_sessions', 'TRUNCATE') AS sessions_truncate,
            has_table_privilege($1, 'app_private.auth_audit_events', 'SELECT') AS audit_select,
            has_table_privilege($1, 'app_private.auth_audit_events', 'INSERT') AS audit_insert,
            has_table_privilege($1, 'app_private.auth_audit_events', 'UPDATE') AS audit_update,
            has_table_privilege($1, 'app_private.auth_audit_events', 'DELETE') AS audit_delete,
            has_table_privilege($1, 'app_private.auth_audit_events', 'TRUNCATE') AS audit_truncate`,
    ['app_backend'],
  )
  const backend = privileges.rows[0]
  assert.ok(backend)
  assert.equal(backend.schema_usage, true)
  assert.equal(backend.schema_create, false)
  for (const privilege of [
    'users_select',
    'users_insert',
    'users_update',
    'sessions_select',
    'sessions_insert',
    'sessions_update',
    'audit_insert',
  ] as const) {
    assert.equal(backend[privilege], true, `app_backend precisa de ${privilege}`)
  }
  for (const privilege of [
    'users_delete',
    'users_truncate',
    'sessions_delete',
    'sessions_truncate',
    'audit_select',
    'audit_update',
    'audit_delete',
    'audit_truncate',
  ] as const) {
    assert.equal(backend[privilege], false, `app_backend não deve ter ${privilege}`)
  }

  for (const roleName of ['anon', 'authenticated'] as const) {
    const result = await pool.query<{ allowed: boolean }>(
      `SELECT has_schema_privilege($1, 'app_private', 'USAGE')
          OR has_schema_privilege($1, 'app_private', 'CREATE')
          OR has_table_privilege($1, 'app_private.users', 'SELECT')
          OR has_table_privilege($1, 'app_private.users', 'INSERT')
          OR has_table_privilege($1, 'app_private.users', 'UPDATE')
          OR has_table_privilege($1, 'app_private.users', 'DELETE')
          OR has_table_privilege($1, 'app_private.users', 'TRUNCATE')
          OR has_table_privilege($1, 'app_private.auth_sessions', 'SELECT')
          OR has_table_privilege($1, 'app_private.auth_sessions', 'INSERT')
          OR has_table_privilege($1, 'app_private.auth_sessions', 'UPDATE')
          OR has_table_privilege($1, 'app_private.auth_sessions', 'DELETE')
          OR has_table_privilege($1, 'app_private.auth_sessions', 'TRUNCATE')
          OR has_table_privilege($1, 'app_private.auth_audit_events', 'SELECT')
          OR has_table_privilege($1, 'app_private.auth_audit_events', 'INSERT')
          OR has_table_privilege($1, 'app_private.auth_audit_events', 'UPDATE')
          OR has_table_privilege($1, 'app_private.auth_audit_events', 'DELETE')
          OR has_table_privilege($1, 'app_private.auth_audit_events', 'TRUNCATE')
          AS allowed`,
      [roleName],
    )
    assert.equal(result.rows[0]?.allowed, false, `${roleName} não deve acessar app_private`)
  }
}

before(async () => {
  const { connectionString } = resolvePostgresTestConnection()
  const container = assertDisposablePostgresContainer()

  rootPool = new Pool({ connectionString, max: 3 })
  try {
    await verifyPostgresTestIdentity(rootPool, container.networkAddresses)
    const relations = await rootPool.query<{ relation: string | null }>(
      `SELECT to_regclass('app_private.users')::text AS relation
       UNION ALL SELECT to_regclass('app_private.auth_sessions')::text
       UNION ALL SELECT to_regclass('app_private.auth_audit_events')::text`,
    )
    assert.equal(relations.rowCount, 3)
    assert.ok(relations.rows.every((row) => row.relation !== null))
    await verifyPreparedRolesAndSecurity()

    const existingData = await rootPool.query<{
      users: boolean
      sessions: boolean
      audit_events: boolean
    }>(`SELECT EXISTS (SELECT 1 FROM app_private.users) AS users,
               EXISTS (SELECT 1 FROM app_private.auth_sessions) AS sessions,
               EXISTS (SELECT 1 FROM app_private.auth_audit_events) AS audit_events`)
    assert.deepEqual(existingData.rows[0], {
      users: false,
      sessions: false,
      audit_events: false,
    })

    ownerPool = new RoleScopedPool(rootPool, 'app_private_owner')
    backendPool = new RoleScopedPool(rootPool, 'app_backend')
    anonymousPool = new RoleScopedPool(rootPool, 'anon')
    authenticatedPool = new RoleScopedPool(rootPool, 'authenticated')

    const administratorId = randomUUID()
    await rootPool.query(
      `INSERT INTO app_private.users
        (id, name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [
        administratorId,
        'Synthetic integration administrator',
        `test-admin-${administratorId}`,
        integrationOnlyPasswordHash,
        authRoles[0],
      ],
    )
    administrator = { userId: administratorId, role: 'administrator' }
  } catch (error) {
    await rootPool.end()
    rootPool = undefined
    throw error
  }
})

after(async () => {
  await Promise.all([
    ownerPool?.drain(),
    backendPool?.drain(),
    anonymousPool?.drain(),
    authenticatedPool?.drain(),
  ])
  await rootPool?.end()
})

test('schema has expected constraints, foreign keys, and indexes in app_private', async () => {
  const pool = getRootPool()
  const indexes = await pool.query<{
    index_name: string
    is_unique: boolean
    schema_name: string
  }>(
    `SELECT index_class.relname AS index_name,
            index_info.indisunique AS is_unique,
            namespace.nspname AS schema_name
       FROM pg_index index_info
       JOIN pg_class index_class ON index_class.oid = index_info.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
      WHERE namespace.nspname = 'app_private'`,
  )
  const indexMap = new Map(indexes.rows.map((row) => [row.index_name, row]))
  for (const name of [
    'users_email_lower_uq',
    'users_username_lower_uq',
    'users_one_active_administrator_uq',
    'auth_sessions_active_user_idx',
    'auth_sessions_expiration_idx',
    'auth_audit_subject_time_idx',
    'auth_audit_actor_time_idx',
    'auth_audit_retention_idx',
  ]) {
    assert.equal(indexMap.get(name)?.schema_name, 'app_private', `${name} schema`)
  }
  assert.equal(indexMap.get('auth_sessions_active_user_idx')?.is_unique, false)
  assert.equal(indexMap.get('users_one_active_administrator_uq')?.is_unique, true)

  const constraints = await pool.query<{
    constraint_name: string
    constraint_type: string
  }>(
    `SELECT conname AS constraint_name, contype AS constraint_type
       FROM pg_constraint
      WHERE connamespace = 'app_private'::regnamespace`,
  )
  const constraintMap = new Map(
    constraints.rows.map((row) => [row.constraint_name, row.constraint_type]),
  )
  assert.equal(constraintMap.get('users_login_identifier_required'), 'c')
  assert.equal(constraintMap.get('users_email_normalized'), 'c')
  assert.equal(constraintMap.get('users_username_normalized'), 'c')
  assert.equal(constraintMap.get('auth_sessions_expiration_after_creation'), 'c')
  assert.ok([...constraintMap.values()].filter((type) => type === 'f').length >= 6)
})

test('anon and authenticated cannot query app_private tables', async () => {
  for (const rolePool of [anonymousPool, authenticatedPool]) {
    await assert.rejects(() =>
      rolePool.query('SELECT id FROM app_private.users LIMIT 1'),
    )
    await assert.rejects(() =>
      rolePool.query('SELECT token_hash FROM app_private.auth_sessions LIMIT 1'),
    )
    await assert.rejects(() =>
      rolePool.query('SELECT event_type FROM app_private.auth_audit_events LIMIT 1'),
    )
  }
})

test('owner role is distinct, non-superuser, and not a runtime role', async () => {
  const result = await ownerPool.query<{
    current_role: string
    is_superuser: boolean
    bypasses_rls: boolean
  }>(`SELECT current_user AS current_role,
             rolsuper AS is_superuser,
             rolbypassrls AS bypasses_rls
        FROM pg_roles
       WHERE rolname = current_user`)

  assert.deepEqual(result.rows[0], {
    current_role: 'app_private_owner',
    is_superuser: false,
    bypasses_rls: false,
  })
})

test('forced RLS prevents the NOLOGIN schema owner from reading synthetic user rows', async () => {
  const result = await ownerPool.query<{ id: string }>(
    `SELECT id::text AS id
       FROM app_private.users
      WHERE id = $1`,
    [administrator.userId],
  )
  assert.equal(result.rows.length, 0)
})

test('backend repository creates and updates synthetic users with audit records', async () => {
  const users = new UserRepository(() => asPool(backendPool))
  const suffix = randomUUID()
  const created = await users.createUser(administrator, {
    name: 'Synthetic integration operator',
    email: `operator-${suffix}@example.invalid`,
    username: `operator-${suffix}`,
    passwordHash: integrationOnlyPasswordHash,
    role: 'slm_operator',
  })

  assert.equal(created.role, 'slm_operator')
  assert.equal(
    (await users.findActiveByLoginIdentifier(created.username!))?.id,
    created.id,
  )

  const audit = await getRootPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM app_private.auth_audit_events
      WHERE subject_user_id = $1 AND event_type = 'user_created'`,
    [created.id],
  )
  assert.equal(audit.rows[0]?.count, '1')
})

test('constraints reject duplicate identifiers, invalid roles, and broken foreign keys', async () => {
  const pool = getRootPool()
  const suffix = randomUUID()
  const email = `constraint-${suffix}@example.invalid`
  await pool.query(
    `INSERT INTO app_private.users (name, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'slm_operator')`,
    [
      'Synthetic constraint test user',
      `constraint-${suffix}`,
      email,
      integrationOnlyPasswordHash,
    ],
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.users (name, username, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'slm_operator')`,
        [
          'Synthetic duplicate email user',
          `different-${suffix}`,
          email,
          integrationOnlyPasswordHash,
        ],
      ),
    (error: { code?: string }) => error.code === '23505',
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.users (name, username, password_hash, role)
         VALUES ($1, $2, $3, 'unauthorized_role')`,
        ['Synthetic invalid role', `invalid-${suffix}`, integrationOnlyPasswordHash],
      ),
    (error: { code?: string }) => error.code === '23514',
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        ['e'.repeat(64), randomUUID()],
      ),
    (error: { code?: string }) => error.code === '23503',
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.users (name, username, password_hash, role)
         VALUES ($1, $2, $3, 'slm_operator')`,
        ['Synthetic invalid username', `Invalid-${suffix}`, integrationOnlyPasswordHash],
      ),
    (error: { code?: string }) => error.code === '23514',
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.auth_sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() - interval '1 hour')`,
        ['f'.repeat(64), administrator.userId],
      ),
    (error: { code?: string }) => error.code === '23514',
  )
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO app_private.users (name, username, password_hash, role)
         VALUES ($1, $2, $3, 'administrator')`,
        ['Synthetic second administrator', `admin-${suffix}`, integrationOnlyPasswordHash],
      ),
    (error: { code?: string }) => error.code === '23505',
  )
})

test('transaction helper rolls back real database writes after an application failure', async () => {
  const pool = asPool(backendPool)
  const username = `rollback-${randomUUID()}`
  await assert.rejects(() =>
    withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO app_private.users (name, username, password_hash, role)
         VALUES ($1, $2, $3, 'slm_operator')`,
        ['Synthetic rollback user', username, integrationOnlyPasswordHash],
      )
      throw new Error('synthetic rollback')
    }),
  )

  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM app_private.users
      WHERE username = $1`,
    [username],
  )
  assert.equal(result.rows[0]?.count, '0')
})

test('session service creates, resolves, deactivates, and revokes synthetic sessions', async () => {
  const users = new UserRepository(() => asPool(backendPool))
  const created = await users.createUser(administrator, {
    name: 'Synthetic session operator',
    username: `session-${randomUUID()}`,
    passwordHash: integrationOnlyPasswordHash,
    role: 'slm_operator',
  })
  const sessions = new SessionService(
    new PostgresSessionStore(() => asPool(backendPool)),
  )
  const issued = await sessions.issue({ userId: created.id, role: created.role })

  assert.deepEqual(await sessions.resolve(issued.token), {
    userId: created.id,
    role: created.role,
    expiresAt: issued.expiresAt,
  })

  await users.updateUser(administrator, created.id, {
    name: created.name,
    username: created.username,
    role: created.role,
    isActive: false,
  })
  await users.updateUser(administrator, created.id, {
    name: created.name,
    username: created.username,
    role: created.role,
    isActive: true,
  })
  assert.equal(await sessions.resolve(issued.token), null)

  const audit = await getRootPool().query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM app_private.auth_audit_events
      WHERE subject_user_id = $1
        AND event_type IN ('session_created', 'session_revoked')`,
    [created.id],
  )
  assert.equal(audit.rows[0]?.count, '2')
})