import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createClearedSessionCookie,
  createSessionCookie,
  readSessionToken,
  sessionCookieName,
} from './cookies.js'

const token = 'a'.repeat(43)

test('sets an HttpOnly SameSite=Lax session cookie and Secure in production', () => {
  const cookie = createSessionCookie(token, Date.now() + 60_000, {
    NODE_ENV: 'production',
  })

  assert.match(cookie, new RegExp(`^${sessionCookieName}=${token};`))
  assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/)
  assert.match(cookie, /(?:^|; )SameSite=Lax(?:;|$)/)
  assert.match(cookie, /(?:^|; )Secure(?:;|$)/)
  assert.match(cookie, /(?:^|; )Max-Age=\d+(?:;|$)/)
  assert.match(cookie, /(?:^|; )Expires=/)
})

test('does not set Secure for local development and clears cookies on logout', () => {
  const developmentCookie = createSessionCookie(
    token,
    Date.now() + 60_000,
    { NODE_ENV: 'development' },
  )
  const clearedCookie = createClearedSessionCookie({ NODE_ENV: 'production' })

  assert.doesNotMatch(developmentCookie, /(?:^|; )Secure(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )HttpOnly(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )SameSite=Lax(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )Secure(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )Max-Age=0(?:;|$)/)
})

test('reads one well-formed session token and rejects ambiguous cookies', () => {
  assert.equal(readSessionToken(`theme=dark; ${sessionCookieName}=${token}`), token)
  assert.equal(readSessionToken(`${sessionCookieName}=${token}; ${sessionCookieName}=${token}`), null)
  assert.equal(readSessionToken(`${sessionCookieName}=invalid`), null)
  assert.equal(readSessionToken(undefined), null)
})