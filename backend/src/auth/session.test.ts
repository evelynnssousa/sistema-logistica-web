import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { SessionService } from './session.js'
import type { SessionStore, StoredSession } from './session.js'

class TestSessionStore implements SessionStore {
  readonly sessions = new Map<string, StoredSession>()

  async save(session: StoredSession) {
    this.sessions.set(session.tokenHash, session)
  }

  async findByTokenHash(tokenHash: string) {
    return this.sessions.get(tokenHash) ?? null
  }

  async deleteByTokenHash(tokenHash: string) {
    this.sessions.delete(tokenHash)
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
    expiresAt: issued.expiresAt,
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