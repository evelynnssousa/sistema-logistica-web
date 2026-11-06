import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachmentDirectoryProblem, projectRoot, resolveAttachmentStorage } from '../attachments/storage.js'
import { checkEnvironment, hasBlockingProblem, passengerKeyProblem } from './environmentCheck.js'

const levelOf = (findings: ReturnType<typeof checkEnvironment>, variable: string) =>
  findings.find((finding) => finding.variable === variable)?.level

test('PASSENGER_DATA_KEY: só 32 bytes em base64, sem valor repetido', () => {
  assert.equal(passengerKeyProblem(undefined), 'ausente')
  assert.equal(passengerKeyProblem('   '), 'ausente')
  assert.equal(passengerKeyProblem(randomBytes(32).toString('base64')), null)
  assert.match(passengerKeyProblem(randomBytes(16).toString('base64')) ?? '', /32 bytes/)
  assert.match(passengerKeyProblem('chave com espaço!') ?? '', /base64/)
  assert.match(passengerKeyProblem(Buffer.alloc(32).toString('base64')) ?? '', /repetido/)
})

test('ATTACHMENTS_DIR: absoluta e fora da pasta do projeto, inclusive na API', () => {
  assert.equal(attachmentDirectoryProblem(undefined), 'ausente')
  assert.match(attachmentDirectoryProblem('anexos') ?? '', /absoluto/)
  assert.match(attachmentDirectoryProblem(projectRoot) ?? '', /dentro da pasta do projeto/)
  assert.match(attachmentDirectoryProblem(join(projectRoot, 'frontend', 'public', 'anexos')) ?? '', /dentro/)
  assert.match(attachmentDirectoryProblem(`${projectRoot}/backend/../anexos`) ?? '', /dentro/)
  assert.equal(attachmentDirectoryProblem(`${projectRoot}-anexos`), null, 'prefixo parecido não é a mesma pasta')
  assert.equal(attachmentDirectoryProblem('/var/lib/slm/anexos'), null)

  assert.equal(resolveAttachmentStorage({ ATTACHMENTS_DIR: join(projectRoot, 'anexos') }), null)
  assert.equal(resolveAttachmentStorage({ ATTACHMENTS_DIR: 'anexos' }), null)
  assert.notEqual(resolveAttachmentStorage({ ATTACHMENTS_DIR: '/var/lib/slm/anexos' }), null)
})

test('conferência do ambiente nunca devolve valores', () => {
  const secrets = {
    DATABASE_URL: 'postgresql://usuario:senha-secreta@banco.example:5432/slm',
    PASSENGER_DATA_KEY: randomBytes(32).toString('base64'),
    RESEND_API_KEY: 're_segredo_do_resend',
    RESEND_FROM: 'SLM <slm@example.gov.br>',
    PASSWORD_RESET_PEPPER: randomBytes(32).toString('hex'),
    GOOGLE_CALENDAR_ENABLED: 'true',
    GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'conta@projeto.iam.gserviceaccount.com',
    GOOGLE_CALENDAR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nsegredo\\n-----END PRIVATE KEY-----',
    GOOGLE_CALENDAR_ID_MAINTENANCE: 'calendario@group.calendar.google.com',
  }
  const text = JSON.stringify(checkEnvironment({ ...secrets, NODE_ENV: 'production' }))
  for (const secret of Object.values(secrets)) {
    if (secret.length > 5) assert.equal(text.includes(secret), false, 'valor apareceu na conferência')
  }
  assert.equal(text.includes('senha-secreta'), false)
})

test('ambiente vazio: avisos de funções indisponíveis, erro só no banco', () => {
  const findings = checkEnvironment({})
  assert.equal(levelOf(findings, 'DATABASE_URL'), 'erro')
  assert.equal(levelOf(findings, 'PASSENGER_DATA_KEY'), 'aviso')
  assert.equal(levelOf(findings, 'ATTACHMENTS_DIR'), 'aviso')
  assert.equal(levelOf(findings, 'RESEND_API_KEY / RESEND_FROM'), 'aviso')
  assert.equal(levelOf(findings, 'PASSWORD_RESET_PEPPER'), 'aviso')
})

test('valores inválidos são erros que bloqueiam', () => {
  const findings = checkEnvironment({
    DATABASE_URL: 'postgresql://x',
    PASSENGER_DATA_KEY: 'curta',
    ATTACHMENTS_DIR: join(projectRoot, 'anexos'),
    RESEND_API_KEY: 're_x',
    RESEND_FROM: 'sem arroba',
    PASSWORD_RESET_PEPPER: 'curto',
    GOOGLE_CALENDAR_ENABLED: 'true',
  })
  for (const variable of ['PASSENGER_DATA_KEY', 'ATTACHMENTS_DIR', 'RESEND_FROM', 'PASSWORD_RESET_PEPPER', 'GOOGLE_CALENDAR_ENABLED']) {
    assert.equal(levelOf(findings, variable), 'erro', variable)
  }
  assert.equal(hasBlockingProblem(findings), true)
})

test('pasta de anexos: existente, gravável e fechada a outros usuários', () => {
  const directory = mkdtempSync(join(tmpdir(), 'slm-env-anexos-'))
  try {
    chmodSync(directory, 0o700)
    assert.equal(levelOf(checkEnvironment({ ATTACHMENTS_DIR: directory }), 'ATTACHMENTS_DIR'), 'ok')
    chmodSync(directory, 0o755)
    assert.equal(levelOf(checkEnvironment({ ATTACHMENTS_DIR: directory }), 'ATTACHMENTS_DIR'), 'aviso')
    const file = join(directory, 'arquivo')
    writeFileSync(file, 'x')
    assert.equal(levelOf(checkEnvironment({ ATTACHMENTS_DIR: file }), 'ATTACHMENTS_DIR'), 'erro')
    assert.equal(levelOf(checkEnvironment({ ATTACHMENTS_DIR: join(directory, 'nova') }), 'ATTACHMENTS_DIR'), 'aviso')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('produção: exige https e aponta transporte simulado', () => {
  const findings = checkEnvironment({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://x',
    FRONTEND_URL: 'http://slm.example.gov.br',
    APP_PUBLIC_URL: 'http://slm.example.gov.br',
    EMAIL_TRANSPORT: 'simulated',
  })
  assert.equal(levelOf(findings, 'FRONTEND_URL'), 'erro')
  assert.equal(levelOf(findings, 'APP_PUBLIC_URL'), 'erro')
  assert.equal(levelOf(findings, 'EMAIL_TRANSPORT'), 'erro')
  assert.equal(levelOf(findings, 'MONITORING_ENABLED'), 'aviso')

  const ready = checkEnvironment({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://x',
    FRONTEND_URL: 'https://slm.example.gov.br',
    APP_PUBLIC_URL: 'https://slm.example.gov.br',
    MONITORING_ENABLED: 'true',
  })
  assert.equal(levelOf(ready, 'FRONTEND_URL'), 'ok')
  assert.equal(levelOf(ready, 'APP_PUBLIC_URL'), 'ok')
  assert.equal(hasBlockingProblem(ready), false)
})
