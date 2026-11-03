import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RateLimiter } from './rateLimiter.js'

function limiterAt(start = 0, limit = 2) {
  const clock = { now: start }
  const limiter = new RateLimiter({
    limit,
    windowMs: 1_000,
    now: () => clock.now,
  })
  return { clock, limiter }
}

test('permite até o limite, bloqueia depois e informa quando tentar de novo', () => {
  const { limiter } = limiterAt()

  assert.deepEqual(limiter.consume('a'), {
    allowed: true,
    remaining: 1,
    retryAfterSeconds: 1,
  })
  assert.equal(limiter.consume('a').remaining, 0)

  const blocked = limiter.consume('a')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSeconds, 1)
})

test('cada chave conta separadamente', () => {
  const { limiter } = limiterAt(0, 1)

  limiter.consume('a')
  assert.equal(limiter.consume('a').allowed, false)
  assert.equal(limiter.consume('b').allowed, true)
})

test('libera novamente quando a janela termina', () => {
  const { clock, limiter } = limiterAt(0, 1)

  limiter.consume('a')
  assert.equal(limiter.check('a').allowed, false)

  clock.now = 1_000
  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.consume('a').allowed, true)
})

test('check não consome, release devolve e reset limpa a contagem', () => {
  const { limiter } = limiterAt(0, 1)

  assert.equal(limiter.check('a').allowed, true)
  assert.equal(limiter.check('a').allowed, true)

  limiter.consume('a')
  limiter.release('a')
  assert.equal(limiter.check('a').allowed, true)

  limiter.consume('a')
  limiter.reset('a')
  assert.equal(limiter.check('a').allowed, true)
})

test('não cresce além do máximo, mesmo com chaves sempre diferentes', () => {
  const limiter = new RateLimiter({
    limit: 1,
    windowMs: 60_000,
    maxEntries: 3,
  })

  for (let index = 0; index < 100; index += 1) {
    limiter.consume(`chave-${index}`)
  }

  assert.equal(limiter.size, 3)
})
