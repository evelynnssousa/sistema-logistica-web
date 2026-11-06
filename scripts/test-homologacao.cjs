#!/usr/bin/env node
/**
 * Testa as travas de scripts/homologacao.cjs só com endereços fictícios e arquivos temporários.
 * Não conecta a nenhum banco e não lê backend/.env.
 */
require('../backend/testing/block-remote-connections.cjs')
const assert = require('node:assert/strict')
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { resolveTarget, stateOf, Refused } = require('./homologacao.cjs')

const dir = mkdtempSync(join(tmpdir(), 'slm-homolog-test-'))
const realEnvFile = join(dir, 'real.env')
const homologFile = join(dir, 'homolog.env')
const missing = join(dir, 'nao-existe.env')
const good = 'postgresql://postgres.rrqulhpnghoetgrdswqr:senha-ficticia-homolog@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
writeFileSync(realEnvFile, 'DATABASE_URL=postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:senha-ficticia-real@aws-1-sa-east-1.pooler.supabase.com:5432/postgres\n')

const target = (value, extra = {}) => resolveTarget({ environment: { SLM_HOMOLOG_DATABASE_URL: value }, homologFile: missing, realEnvFile, ...extra })
const refused = (value, pattern, why, extra) => assert.throws(() => target(value, extra), (e) => e instanceof Refused && pattern.test(e.message), why)

try {
  const ok = target(`${good}?sslmode=require`)
  assert.equal(ok.url.searchParams.has('sslmode'), false, 'sslmode é retirado: o TLS é verificado pelo script')
  assert.equal(ok.description.includes('senha'), false, 'a descrição não traz a senha')
  assert.match(ok.description, /rrqulhpnghoetgrdswqr/)
  console.log('✔ aceita o Session pooler do projeto de homologação, sem expor a senha')

  refused(good.replace('postgres.rrqulhpnghoetgrdswqr', 'postgres.aaaaaaaaaaaaaaaaaaaa'), /usuário precisa ser postgres\.rrqulhpnghoetgrdswqr/, 'outro projeto')
  refused(good.replace('postgres.rrqulhpnghoetgrdswqr', 'postgres'), /usuário precisa ser/, 'usuário sem projeto')
  refused(good.replace('aws-1-sa-east-1.pooler.supabase.com', 'db.rrqulhpnghoetgrdswqr.supabase.co'), /Session pooler/, 'conexão direta (IPv6)')
  refused(good.replace(':5432/', ':6543/'), /porta 5432/, 'transaction pooler')
  refused(good.replace(':5432/postgres', ':5432/outro'), /\/postgres/, 'outro banco')
  refused(good.replace('aws-1-sa-east-1.pooler.supabase.com', 'localhost'), /Session pooler/, 'local')
  refused('isso não é url', /URL válida/, 'texto qualquer')
  console.log('✔ recusa outro projeto, conexão direta, transaction pooler, outro banco e endereço inválido')

  writeFileSync(join(dir, 'real-homolog.env'), `DATABASE_URL=${good}\n`)
  refused(good, /backend\/.env aponta para o projeto de homologação/, 'real apontando para homologação', { realEnvFile: join(dir, 'real-homolog.env') })
  writeFileSync(join(dir, 'real-mesma-senha.env'), 'DATABASE_URL=postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:senha-ficticia-homolog@aws-1-sa-east-1.pooler.supabase.com:5432/postgres\n')
  refused(good, /senha da homologação é igual/, 'senha reaproveitada', { realEnvFile: join(dir, 'real-mesma-senha.env') })
  console.log('✔ recusa quando o backend/.env aponta para a homologação ou a senha é a mesma do banco real')

  assert.throws(() => resolveTarget({ environment: {}, homologFile: missing, realEnvFile }), /Credencial da homologação não encontrada/)
  writeFileSync(homologFile, `DATABASE_URL=${good}\n`)
  chmodSync(homologFile, 0o644)
  assert.throws(() => resolveTarget({ environment: {}, homologFile, realEnvFile }), /permissão 600/)
  chmodSync(homologFile, 0o600)
  assert.match(resolveTarget({ environment: {}, homologFile, realEnvFile }).source, /backend\/.env.homologacao/)
  console.log('✔ sem credencial recusa; o arquivo local só vale com permissão 600; o segredo tem prioridade')

  assert.equal(stateOf([]), 'vazio')
  const legacy = ['auth_audit_events', 'auth_sessions', 'auth_users', 'material_request_items', 'material_requests', 'materials', 'request_forms', 'request_history', 'service_requests', 'setores', 'stock_movements']
  assert.equal(stateOf(legacy.map((relname) => ({ relname }))), 'estrutura-inicial')
  assert.equal(stateOf([...legacy, 'catalog_options'].map((relname) => ({ relname }))), 'outro')
  assert.equal(stateOf([{ relname: 'qualquer' }]), 'outro')
  console.log('✔ distingue banco vazio, só com a estrutura inicial e com objetos inesperados')
  console.log('Teste do acesso à homologação concluído.')
} catch (error) {
  console.error(`Teste interrompido: ${error.message}`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
