const assert = require('node:assert/strict')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const express = require('express')
const test = require('node:test')
const { createApp } = require('../dist/app.js')
const { hashPassword } = require('../dist/auth/password.js')
const { canAccess } = require('../dist/auth/permissions.js')
const { requirePermission } = require('../dist/auth/authorization.js')
const { hashToken } = require('../dist/auth/session.js')
const { createAuthRouter } = require('../dist/routes/auth.routes.js')

const origin = 'http://localhost:5173'
const email = 'ana@jucesp.sp.gov.br'
const password = 'senha-forte-de-teste-2026'

class MemoryAuthRepository {
  users = new Map()
  sessions = new Map()
  auditEvents = []

  async createPendingUser(input) {
    if (await this.findUserByEmail(input.email)) {
      const error = new Error('duplicate')
      error.code = '23505'
      throw error
    }
    const user = {
      id: randomUUID(),
      fullName: input.fullName,
      email: input.email,
      sector: input.sector,
      passwordHash: input.passwordHash,
      status: 'pending',
      role: null,
      permissions: [],
      createdAt: new Date(),
    }
    this.users.set(user.id, user)
    await this.createAuditEvent({
      actorUserId: user.id,
      action: 'registration.requested',
      targetUserId: user.id,
      result: 'success',
    })
    return user
  }

  async findUserByEmail(value) {
    return [...this.users.values()].find((user) => user.email === value) ?? null
  }

  async findUserById(id) {
    return this.users.get(id) ?? null
  }

  async createSession(session) {
    const id = randomUUID()
    this.sessions.set(session.sessionTokenHash, { ...session, id })
  }

  async findSessionByTokenHash(tokenHash) {
    const session = this.sessions.get(tokenHash)
    return session && session.expiresAt > new Date() ? session : null
  }

  async deleteSession(tokenHash) {
    this.sessions.delete(tokenHash)
  }

  async endSession(tokenHash, actorUserId) {
    this.sessions.delete(tokenHash)
    await this.createAuditEvent({
      actorUserId,
      action: 'auth.logout',
      targetUserId: actorUserId,
      result: 'success',
    })
  }

  async listPendingUsers() {
    return [...this.users.values()]
      .filter((user) => user.status === 'pending')
      .map(({ passwordHash: _passwordHash, ...user }) => user)
  }

  async decideRegistration(id, actorUserId, decision) {
    const user = this.users.get(id)
    if (!user || user.status !== 'pending') return null
    user.status = decision.action === 'approve' ? 'approved' : 'rejected'
    user.role = decision.action === 'approve' ? decision.role : null
    user.permissions = decision.action === 'approve' ? decision.permissions : []
    if (decision.action === 'reject') {
      for (const [token, session] of this.sessions) {
        if (session.userId === id) this.sessions.delete(token)
      }
    }
    await this.createAuditEvent({
      actorUserId,
      action: `registration.${decision.action}`,
      targetUserId: id,
      result: 'success',
    })
    return user
  }

  async setUserStatus(id, actorUserId, status) {
    const user = this.users.get(id)
    if (!user || user.status !== 'approved') return null
    user.status = status
    for (const [token, session] of this.sessions) {
      if (session.userId === id) this.sessions.delete(token)
    }
    await this.createAuditEvent({
      actorUserId,
      action: `account.${status}`,
      targetUserId: id,
      result: 'success',
    })
    return user
  }

  async hasAdministrator() {
    return [...this.users.values()].some((user) => user.role === 'admin' && user.status === 'approved')
  }

  async hasOtherAdministrator(id) {
    return [...this.users.values()].some((user) => user.id !== id && user.role === 'admin' && user.status === 'approved')
  }

  async createAuditEvent(event) {
    this.auditEvents.push(event)
  }

  async createInitialAdministrator(input) {
    const user = {
      id: randomUUID(),
      fullName: input.fullName,
      email: input.email,
      sector: input.sector,
      passwordHash: input.passwordHash,
      status: 'approved',
      role: 'admin',
      permissions: [],
      createdAt: new Date(),
    }
    this.users.set(user.id, user)
    return user
  }

  async seedUser({ fullName, email: userEmail, status, role, permissions = [], userPassword = password }) {
    const user = {
      id: randomUUID(),
      fullName,
      email: userEmail,
      sector: 'Operações',
      passwordHash: await hashPassword(userPassword),
      status,
      role,
      permissions,
      createdAt: new Date(),
    }
    this.users.set(user.id, user)
    return user
  }
}

async function startServer(repository, application) {
  process.env.INSTITUTIONAL_EMAIL_DOMAINS = 'jucesp.sp.gov.br'
  const server = (application ?? createApp(repository)).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function cookieHeader(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ')
}

function cookieValue(header, name) {
  const entry = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return entry?.slice(name.length + 1)
}

async function call(server, path, { method = 'GET', body, cookies, csrf, includeOrigin = true, originValue = origin } = {}) {
  const headers = {}
  if (includeOrigin) headers.Origin = originValue
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookies) headers.Cookie = cookies
  if (csrf) headers['X-CSRF-Token'] = csrf
  return fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function register(server, fields = {}) {
  return call(server, '/api/auth/register', {
    method: 'POST',
    body: {
      fullName: 'Ana Silva',
      email,
      sector: 'Operações',
      password,
      passwordConfirmation: password,
      ...fields,
    },
  })
}

async function login(server, userEmail = email, userPassword = password) {
  const response = await call(server, '/api/auth/login', {
    method: 'POST',
    body: { email: userEmail, password: userPassword },
  })
  return { response, body: await response.json(), cookies: cookieHeader(response) }
}

test('cadastro valida campos, normaliza e-mail e cria somente conta pendente', async () => {
  const repository = new MemoryAuthRepository()
  const server = await startServer(repository)
  try {
    const invalid = await register(server, { fullName: 'A', password: 'curta', passwordConfirmation: 'outra' })
    assert.equal(invalid.status, 400)
    const mismatch = await register(server, { passwordConfirmation: 'senha-diferente-2026' })
    assert.equal(mismatch.status, 400)

    const response = await register(server, { email: ' ANA@JUCESP.SP.GOV.BR ' })
    assert.equal(response.status, 202)
    assert.match((await response.json()).message, /após aprovação/i)
    const user = await repository.findUserByEmail(email)
    assert.equal(user.status, 'pending')
    assert.equal(user.role, null)
    assert.notEqual(user.passwordHash, password)
  } finally {
    await server.close()
  }
})

test('cadastro rejeita duplicidade, domínio não autorizado e tentativa de conceder privilégio', async () => {
  const repository = new MemoryAuthRepository()
  const server = await startServer(repository)
  try {
    assert.equal((await register(server)).status, 202)
    assert.equal((await register(server)).status, 409)
    assert.equal((await register(server, { email: 'x@outro.example' })).status, 400)
    assert.equal((await register(server, { role: 'admin' })).status, 400)
    assert.equal((await register(server, { permissions: ['settings:write'] })).status, 400)
  } finally {
    await server.close()
  }
})

test('conta pendente ou rejeitada não obtém login nem sessão por rota direta', async () => {
  const repository = new MemoryAuthRepository()
  const pending = await repository.seedUser({ fullName: 'Ana Silva', email, status: 'pending', role: null })
  const rejected = await repository.seedUser({ fullName: 'Bruna Lima', email: 'bruna@jucesp.sp.gov.br', status: 'rejected', role: null })
  const server = await startServer(repository)
  try {
    const pendingLogin = await login(server)
    assert.equal(pendingLogin.response.status, 403)
    assert.equal(pendingLogin.body.error.code, 'ACCOUNT_PENDING')
    const rejectedLogin = await login(server, rejected.email)
    assert.equal(rejectedLogin.response.status, 403)
    assert.equal(rejectedLogin.body.error.code, 'ACCOUNT_REJECTED')
    assert.equal((await call(server, '/api/auth/session')).status, 401)
    assert.equal(repository.sessions.size, 0)
    const pendingToken = 'pending-account-session-token'
    repository.sessions.set(hashToken(pendingToken), {
      id: randomUUID(),
      userId: pending.id,
      sessionTokenHash: hashToken(pendingToken),
      csrfTokenHash: hashToken('pending-account-csrf-token'),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const pendingCookies = `slm_session=${pendingToken}; slm_csrf=pending-account-csrf-token`
    assert.equal((await call(server, '/api/auth/session', { cookies: pendingCookies })).status, 401)
    assert.equal((await call(server, '/api/admin/registration-requests', { cookies: pendingCookies })).status, 401)
    const forgedToken = 'rejected-account-session-token'
    repository.sessions.set(hashToken(forgedToken), {
      id: randomUUID(),
      userId: rejected.id,
      sessionTokenHash: hashToken(forgedToken),
      csrfTokenHash: hashToken('rejected-account-csrf-token'),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const forgedCookies = `slm_session=${forgedToken}; slm_csrf=rejected-account-csrf-token`
    assert.equal((await call(server, '/api/auth/session', { cookies: forgedCookies })).status, 401)
    assert.equal((await call(server, '/api/admin/registration-requests', { cookies: forgedCookies })).status, 401)
    assert.ok(repository.users.has(pending.id))
  } finally {
    await server.close()
  }
})

test('conta inativa é recusada no login', async () => {
  const repository = new MemoryAuthRepository()
  await repository.seedUser({ fullName: 'Ana Silva', email, status: 'inactive', role: 'operator' })
  const server = await startServer(repository)
  try {
    const result = await login(server)
    assert.equal(result.response.status, 403)
    assert.equal(result.body.error.code, 'ACCOUNT_INACTIVE')
    assert.equal(repository.sessions.size, 0)
  } finally {
    await server.close()
  }
})

test('login de conta aprovada cria cookie HttpOnly; sessão, CSRF e logout são verificados', async () => {
  const repository = new MemoryAuthRepository()
  await repository.seedUser({ fullName: 'Ana Silva', email, status: 'approved', role: 'operator', permissions: ['fleet:read'] })
  const server = await startServer(repository)
  try {
    const signedIn = await login(server)
    assert.equal(signedIn.response.status, 200)
    assert.match(signedIn.response.headers.getSetCookie().join(';'), /slm_session=.*HttpOnly/i)
    const sessionCookie = signedIn.cookies.split('; ').find((cookie) => cookie.startsWith('slm_session='))
    const csrfCookie = signedIn.cookies.split('; ').find((cookie) => cookie.startsWith('slm_csrf='))
    const csrfToken = signedIn.body.csrfToken
    assert.equal(cookieValue(signedIn.cookies, 'slm_csrf'), csrfToken)
    assert.equal(repository.sessions.has(cookieValue(signedIn.cookies, 'slm_session')), false)

    const session = await call(server, '/api/auth/session', { cookies: signedIn.cookies })
    assert.equal(session.status, 200)
    assert.equal((await session.json()).user.email, email)

    const rejectedLogout = await call(server, '/api/auth/logout', { method: 'POST', cookies: signedIn.cookies })
    assert.equal(rejectedLogout.status, 403)
    const logout = await call(server, '/api/auth/logout', { method: 'POST', cookies: signedIn.cookies, csrf: csrfToken })
    assert.equal(logout.status, 204)
    assert.equal((await call(server, '/api/auth/session', { cookies: `${sessionCookie}; ${csrfCookie}` })).status, 401)
  } finally {
    await server.close()
  }
})

test('cookies de sessão são Secure quando a aplicação opera em produção', async () => {
  const repository = new MemoryAuthRepository()
  await repository.seedUser({ fullName: 'Ana Silva', email, status: 'approved', role: 'operator' })
  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter({
    repository,
    allowedEmailDomains: ['jucesp.sp.gov.br'],
    allowedOrigins: [origin],
    secureCookies: true,
  }))
  const server = await startServer(repository, app)
  try {
    const result = await login(server)
    assert.equal(result.response.status, 200)
    const sessionCookie = result.response.headers.getSetCookie().find((cookie) => cookie.startsWith('slm_session='))
    assert.match(sessionCookie, /HttpOnly/i)
    assert.match(sessionCookie, /Secure/i)
    assert.match(sessionCookie, /SameSite=Lax/i)
  } finally {
    await server.close()
  }
})

test('login recusa conta bloqueada e bloqueio invalida sessão ativa', async () => {
  const repository = new MemoryAuthRepository()
  const admin = await repository.seedUser({ fullName: 'Admin', email: 'admin@jucesp.sp.gov.br', status: 'approved', role: 'admin' })
  const operator = await repository.seedUser({ fullName: 'Ana Silva', email, status: 'approved', role: 'operator' })
  const server = await startServer(repository)
  try {
    const operatorSession = await login(server)
    assert.equal(operatorSession.response.status, 200)
    const adminSession = await login(server, admin.email)
    const cookies = adminSession.cookies
    const blocked = await call(server, `/api/admin/users/${operator.id}/block`, {
      method: 'POST',
      cookies,
      csrf: adminSession.body.csrfToken,
      body: {},
    })
    assert.equal(blocked.status, 200)
    assert.equal((await call(server, '/api/auth/session', { cookies: operatorSession.cookies })).status, 401)
    const blockedLogin = await login(server)
    assert.equal(blockedLogin.response.status, 403)
    assert.equal(blockedLogin.body.error.code, 'ACCOUNT_BLOCKED')
  } finally {
    await server.close()
  }
})

test('apenas administrador aprova conta, define permissões e não pode autoaprovar', async () => {
  const repository = new MemoryAuthRepository()
  const admin = await repository.seedUser({ fullName: 'Admin', email: 'admin@jucesp.sp.gov.br', status: 'approved', role: 'admin' })
  const operator = await repository.seedUser({ fullName: 'Operador', email: 'op@jucesp.sp.gov.br', status: 'approved', role: 'operator' })
  const selfRequest = await repository.createPendingUser({
    fullName: 'Admin', email: 'self@jucesp.sp.gov.br', sector: 'Operações', passwordHash: await hashPassword(password),
  })
  const request = await repository.createPendingUser({
    fullName: 'Ana Silva', email, sector: 'Frota', passwordHash: await hashPassword(password),
  })
  const server = await startServer(repository)
  try {
    const operatorSession = await login(server, operator.email)
    const denied = await call(server, '/api/admin/registration-requests', { cookies: operatorSession.cookies })
    assert.equal(denied.status, 403)

    const adminSession = await login(server, admin.email)
    const selfDecision = await call(server, `/api/admin/registration-requests/${admin.id}/decision`, {
      method: 'POST',
      cookies: adminSession.cookies,
      csrf: adminSession.body.csrfToken,
      body: { action: 'approve', role: 'admin', permissions: [] },
    })
    assert.equal(selfDecision.status, 403)

    const approved = await call(server, `/api/admin/registration-requests/${request.id}/decision`, {
      method: 'POST',
      cookies: adminSession.cookies,
      csrf: adminSession.body.csrfToken,
      body: { action: 'approve', role: 'operator', permissions: ['fleet:read'] },
    })
    assert.equal(approved.status, 200)
    assert.deepEqual((await approved.json()).user.permissions, ['fleet:read'])
    const afterApproval = await login(server, email)
    assert.equal(afterApproval.response.status, 200)

    const ownRequestDecision = await call(server, `/api/admin/registration-requests/${admin.id}/decision`, {
      method: 'POST',
      cookies: adminSession.cookies,
      csrf: adminSession.body.csrfToken,
      body: { action: 'approve', role: 'admin', permissions: [] },
    })
    assert.equal(ownRequestDecision.status, 403)
    assert.ok(repository.auditEvents.some((event) => event.result === 'denied' && event.action === 'registration.approve'))
    assert.equal(repository.users.get(selfRequest.id).status, 'pending')
  } finally {
    await server.close()
  }
})

test('rejeição fica auditada e não cria sessão; operações administrativas exigem CSRF', async () => {
  const repository = new MemoryAuthRepository()
  const admin = await repository.seedUser({ fullName: 'Admin', email: 'admin@jucesp.sp.gov.br', status: 'approved', role: 'admin' })
  const request = await repository.createPendingUser({
    fullName: 'Ana Silva', email, sector: 'Operações', passwordHash: await hashPassword(password),
  })
  const server = await startServer(repository)
  try {
    const adminSession = await login(server, admin.email)
    const foreignOriginDecision = await call(server, `/api/admin/registration-requests/${request.id}/decision`, {
      method: 'POST',
      cookies: adminSession.cookies,
      csrf: adminSession.body.csrfToken,
      originValue: 'https://untrusted.example',
      body: { action: 'reject' },
    })
    assert.equal(foreignOriginDecision.status, 403)

    const withoutCsrf = await call(server, `/api/admin/registration-requests/${request.id}/decision`, {
      method: 'POST', cookies: adminSession.cookies, body: { action: 'reject' },
    })
    assert.equal(withoutCsrf.status, 403)
    const rejected = await call(server, `/api/admin/registration-requests/${request.id}/decision`, {
      method: 'POST',
      cookies: adminSession.cookies,
      csrf: adminSession.body.csrfToken,
      body: { action: 'reject' },
    })
    assert.equal(rejected.status, 200)
    assert.ok(repository.auditEvents.some((event) => event.action === 'registration.reject' && event.actorUserId === admin.id))
    assert.equal((await login(server, email)).response.status, 403)
    assert.equal(repository.sessions.size, 1)
  } finally {
    await server.close()
  }
})

test('mutating authentication requests require the configured origin', async () => {
  const repository = new MemoryAuthRepository()
  const server = await startServer(repository)
  try {
    const response = await call(server, '/api/auth/register', {
      method: 'POST',
      body: { fullName: 'Ana Silva', email, sector: 'Operações', password, passwordConfirmation: password },
      includeOrigin: false,
    })
    assert.equal(response.status, 403)
    assert.equal(repository.users.size, 0)
  } finally {
    await server.close()
  }
})

test('CPF exige permissão explícita inclusive para administradores', () => {
  assert.equal(canAccess('admin', [], 'flights:cpf:read'), false)
  assert.equal(canAccess('admin', ['flights:cpf:read'], 'flights:cpf:read'), true)
  assert.equal(canAccess('operator', ['flights:read'], 'flights:cpf:read'), false)
  assert.equal(canAccess('operator', ['fleet:read'], 'fleet:read'), true)
})

test('middleware de CPF bloqueia acesso sem concessão e audita acesso autorizado sem guardar CPF', async () => {
  const repository = new MemoryAuthRepository()
  const withoutAccess = await repository.seedUser({
    fullName: 'Admin', email: 'admin@jucesp.sp.gov.br', status: 'approved', role: 'admin', permissions: [],
  })
  const withAccess = await repository.seedUser({
    fullName: 'Analista', email: 'analista@jucesp.sp.gov.br', status: 'approved', role: 'operator',
    permissions: ['flights:cpf:read'],
  })
  const authServer = await startServer(repository)
  const moduleApp = express()
  moduleApp.get('/api/passengers/:passengerId/cpf', requirePermission(repository, 'flights:cpf:read'), (_request, response) => {
    response.json({ accessed: true })
  })
  const protectedServer = await startServer(repository, moduleApp)
  try {
    const adminSession = await login(authServer, withoutAccess.email)
    const adminAttempt = await call(protectedServer, '/api/passengers/passenger-123/cpf', {
      cookies: adminSession.cookies,
    })
    assert.equal(adminAttempt.status, 403)

    const allowedSession = await login(authServer, withAccess.email)
    const allowed = await call(protectedServer, '/api/passengers/passenger-123/cpf', {
      cookies: allowedSession.cookies,
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { accessed: true })
    const audit = repository.auditEvents.find((event) => event.action === 'passenger.cpf.access')
    assert.equal(audit.actorUserId, withAccess.id)
    assert.equal(audit.targetResourceId, 'passenger-123')
    assert.equal(JSON.stringify(audit).includes('123.456.789-00'), false)
  } finally {
    await Promise.all([authServer.close(), protectedServer.close()])
  }
})

test('sem banco configurado health continua disponível e autenticação retorna 503', async () => {
  const server = await startServer(null)
  try {
    const health = await call(server, '/api/health', { includeOrigin: false })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).success, true)

    const registration = await call(server, '/api/auth/register', {
      method: 'POST',
      body: { fullName: 'Ana Silva', email, sector: 'Operações', password, passwordConfirmation: password },
    })
    assert.equal(registration.status, 503)
    assert.equal((await registration.json()).error.code, 'AUTH_DATABASE_UNAVAILABLE')
  } finally {
    await server.close()
  }
})

test('JSON malformado é recusado como erro de cliente', async () => {
  const repository = new MemoryAuthRepository()
  const server = await startServer(repository)
  try {
    const response = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_JSON')
  } finally {
    await server.close()
  }
})