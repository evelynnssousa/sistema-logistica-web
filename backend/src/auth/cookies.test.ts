import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createClearedSessionCookie,
  createSessionCookie,
  readSessionToken,
  sessionCookieName,
} from './cookies.js'

const token = 'a'.repeat(43)

test('sets an HttpOnly SameSite=Strict session cookie and Secure in production', () => {
  const cookie = createSessionCookie(token, Date.now() + 60_000, {
    NODE_ENV: 'production',
  })

  assert.match(cookie, new RegExp(`^${sessionCookieName}=${token};`))
  assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/)
  assert.match(cookie, /(?:^|; )SameSite=Strict(?:;|$)/)
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
  assert.match(clearedCookie, /(?:^|; )SameSite=Strict(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )Secure(?:;|$)/)
  assert.match(clearedCookie, /(?:^|; )Max-Age=0(?:;|$)/)
})

test('COOKIE_SECURE turns on Secure outside production and cannot turn it off there', () => {
  const secure = /(?:^|; )Secure(?:;|$)/

  assert.match(
    createSessionCookie(token, Date.now() + 60_000, { COOKIE_SECURE: 'true' }),
    secure,
  )
  assert.doesNotMatch(
    createSessionCookie(token, Date.now() + 60_000, { COOKIE_SECURE: 'false' }),
    secure,
  )
  assert.match(
    createSessionCookie(token, Date.now() + 60_000, {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
    }),
    secure,
  )
})

test('reads one well-formed session token and rejects ambiguous cookies', () => {
  assert.equal(readSessionToken(`theme=dark; ${sessionCookieName}=${token}`), token)
  // O mesmo valor repetido não é ambíguo; valores diferentes são.
  assert.equal(readSessionToken(`${sessionCookieName}=${token}; ${sessionCookieName}=${token}`), token)
  assert.equal(readSessionToken(`${sessionCookieName}=${token}; ${sessionCookieName}=${'b'.repeat(43)}`), null)
  assert.equal(readSessionToken(`${sessionCookieName}=invalid`), null)
  assert.equal(readSessionToken(undefined), null)
})