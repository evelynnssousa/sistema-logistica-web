import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import { SessionService } from './session.js'
import { startSessionCleanup } from './sessionRuntime.js'
import { deriveCsrfToken, hashCsrfToken } from './csrf.js'
import type { SessionEndReason, SessionStore, StoredSession } from './session.js'

class TestSessionStore implements SessionStore {
  readonly sessions = new Map<string, StoredSession>()
  readonly endReasons: Array<SessionEndReason | undefined> = []
  readonly idleCutoffs: number[] = []
  touches = 0

  async save(session: StoredSession) {
    this.sessions.set(session.tokenHash, session)
  }

  async findByTokenHash(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null
  }

  async deleteByTokenHash(tokenHash: string, reason?: SessionEndReason) {
    this.endReasons.push(reason)
    this.sessions.delete(tokenHash)
  }

  async touch(tokenHash: string, lastSeenAt: number) {
    this.touches += 1
    const session = this.sessions.get(tokenHash)
    if (session) session.lastSeenAt = lastSeenAt
  }

  async deleteExpired(idleCutoff: number) {
    this.idleCutoffs.push(idleCutoff)
    return 3
  }
}

test('stores only a token hash, resolves trusted identity, and revokes on logout', async () => {
  const store = new TestSessionStore()
  const service = new SessionService(store, { now: () => 1_000 })
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'slm_operator',
  })
  const tokenHash = createHash('sha256').update(issued.token).digest('hex')

  assert.equal(store.sessions.has(tokenHash), true)
  assert.equal([...store.sessions.values()][0].tokenHash.includes(issued.token), false)
  assert.deepEqual(await service.resolve(issued.token), {
    userId: 'server-user-id',
    role: 'slm_operator',
    permissions: [],
    slmMember: false,
    sector: '',
    expiresAt: issued.expiresAt,
    csrfTokenHash: hashCsrfToken(issued.csrfToken),
  })

  await service.revoke(issued.token)
  assert.equal(await service.resolve(issued.token), null)
})

test('expires and deletes sessions at the configured deadline', async () => {
  const store = new TestSessionStore()
  let now = 2_000
  const service = new SessionService(store, { ttlMs: 500, now: () => now })
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'administrator',
  })

  now = issued.expiresAt
  assert.equal(await service.resolve(issued.token), null)
  assert.equal(store.sessions.size, 0)
})

test('rejects client-shaped identities and malformed tokens', async () => {
  const service = new SessionService(new TestSessionStore())

  await assert.rejects(() =>
    service.issue({ userId: ' ', role: 'slm_operator' }),
  )
  assert.equal(await service.resolve('client-supplied-id'), null)
})

test('stores only the hash of the CSRF token, derived from the session token', async () => {
  const store = new TestSessionStore()
  const service = new SessionService(store)
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'administrator',
  })
  const stored = [...store.sessions.values()][0]

  assert.equal(issued.csrfToken, deriveCsrfToken(issued.token))
  assert.equal(stored.csrfTokenHash, hashCsrfToken(issued.csrfToken))
  assert.equal(JSON.stringify(stored).includes(issued.csrfToken), false)
  assert.equal(JSON.stringify(stored).includes(issued.token), false)
})

test('ends idle sessions and records why', async () => {
  const store = new TestSessionStore()
  let now = 0
  const service = new SessionService(store, {
    ttlMs: 10_000,
    idleTimeoutMs: 1_000,
    now: () => now,
  })
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'administrator',
  })

  now = 1_000
  assert.equal(await service.resolve(issued.token), null)
  assert.equal(store.sessions.size, 0)
  assert.deepEqual(store.endReasons, ['idle_timeout'])
})

test('activity keeps a session alive, but never past its absolute deadline', async () => {
  const store = new TestSessionStore()
  let now = 0
  const service = new SessionService(store, {
    ttlMs: 2_500,
    idleTimeoutMs: 1_000,
    touchIntervalMs: 100,
    now: () => now,
  })
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'administrator',
  })

  for (now = 800; now < 2_500; now += 800) {
    assert.ok(await service.resolve(issued.token), `at ${now}`)
  }
  assert.ok(store.touches > 0)

  now = 2_500
  assert.equal(await service.resolve(issued.token), null)
  assert.deepEqual(store.endReasons, ['expired'])
})

test('records activity only from time to time', async () => {
  const store = new TestSessionStore()
  let now = 0
  const service = new SessionService(store, {
    idleTimeoutMs: 10_000,
    touchIntervalMs: 1_000,
    now: () => now,
  })
  const issued = await service.issue({
    userId: 'server-user-id',
    role: 'administrator',
  })

  now = 500
  await service.resolve(issued.token)
  assert.equal(store.touches, 0)

  now = 1_000
  await service.resolve(issued.token)
  await service.resolve(issued.token)
  assert.equal(store.touches, 1)
})

test('purges sessions using the idle cutoff', async () => {
  const store = new TestSessionStore()
  const service = new SessionService(store, {
    idleTimeoutMs: 1_000,
    now: () => 5_000,
  })

  assert.equal(await service.purgeExpired(), 3)
  assert.deepEqual(store.idleCutoffs, [4_000])
})

test('the cleanup routine survives a database failure', async () => {
  const warn = mock.method(console, 'warn', () => {})
  let calls = 0

  const timer = startSessionCleanup({
    purgeExpired: async () => {
      calls += 1
      throw new Error('banco fora do ar')
    },
  })
  await new Promise((done) => setImmediate(done))
  clearInterval(timer)

  const logged = warn.mock.calls.map((call) => String(call.arguments[0])).join()
  warn.mock.restore()
  assert.equal(calls, 1)
  assert.match(logged, /session_purge_failed/)
  assert.doesNotMatch(logged, /banco fora do ar/)
})
