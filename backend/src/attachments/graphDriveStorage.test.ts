import assert from 'node:assert/strict'
import { createHash, createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import type { Pool } from 'pg'
import type { AuthenticatedIdentity } from '../auth/roles.js'
import { checkEnvironment } from '../config/environmentCheck.js'
import { AttachmentRepository } from '../database/attachmentRepository.js'
import { FakeGraph, fakeClient, fakeDrive, fakeSecret, fakeSettings, fakeTenant, json } from './fakeGraph.testSupport.js'
import { buildClientAssertion, GraphStorageError } from './graphAuth.js'
import { GraphDriveStorage, graphStorageSettings, retryAfterMs, uploadFragmentUnit } from './graphDriveStorage.js'
import {
  AttachmentIntegrityError,
  LocalDiskStorage,
  resolveAttachmentStorage,
  setAttachmentStorageForTests,
  verifyContent,
} from './storage.js'

// SharePoint pelo Microsoft Graph simulado: nenhuma conta real, nenhuma conexão para fora.

function storageWith(graph: FakeGraph, options: ConstructorParameters<typeof GraphDriveStorage>[1] = {}) {
  return new GraphDriveStorage(fakeSettings, {
    fetcher: graph.fetch,
    now: graph.now,
    sleep: graph.sleep,
    random: () => 0,
    fragmentBytes: uploadFragmentUnit,
    ...options,
  })
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const codeOf = (code: string) => (error: unknown) => {
  assert.ok(error instanceof GraphStorageError, `esperado GraphStorageError, veio ${String(error)}`)
  assert.equal(error.code, code)
  return true
}

/** Nem o segredo, nem o token, nem a URL temporária aparecem em mensagem de erro. */
function assertNoSecretIn(error: unknown, graph: FakeGraph) {
  const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`
  assert.equal(text.includes(fakeSecret), false)
  for (const token of graph.issuedTokens) assert.equal(text.includes(token), false)
  assert.equal(text.includes('tempauth'), false)
  assert.equal(text.includes('sharepoint.com'), false)
}

const content = (size: number) => randomBytes(size)

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

test('upload: sessão do Graph, partes de 320 KiB e URL da sessão sem o token', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  const file = content(uploadFragmentUnit * 2 + 1234)

  await storage.save(key, file)

  assert.deepEqual(graph.files.get(graph.pathOf(key)), file)
  const session = graph.requests.find((request) => request.url.endsWith(':/createUploadSession'))!
  assert.match(session.url, new RegExp(`/drives/${encodeURIComponent(fakeDrive)}/root:/SLM-Anexos/${key.slice(0, 2)}/${key}:/createUploadSession$`))
  assert.match(session.authorization ?? '', /^Bearer token-ficticio-/)
  assert.equal(JSON.parse(session.body!.toString()).item['@microsoft.graph.conflictBehavior'], 'fail')

  const fragments = graph.requests.filter((request) => request.method === 'PUT')
  assert.deepEqual(
    fragments.map((request) => request.contentRange),
    [
      `bytes 0-${uploadFragmentUnit - 1}/${file.length}`,
      `bytes ${uploadFragmentUnit}-${uploadFragmentUnit * 2 - 1}/${file.length}`,
      `bytes ${uploadFragmentUnit * 2}-${file.length - 1}/${file.length}`,
    ],
  )
  assert.ok(fragments.every((request) => request.authorization === null), 'o token não vai para a URL da sessão')
  assert.equal(graph.issuedTokens.length, 1, 'o token é reaproveitado')
  assert.equal(graph.openSessions(), 0)
})

test('upload: o tamanho das partes respeita o mínimo e o máximo do Graph', () => {
  assert.throws(() => storageWith(new FakeGraph(), { fragmentBytes: 1000 }), /320 KiB/)
  assert.throws(() => storageWith(new FakeGraph(), { fragmentBytes: 61 * 1024 * 1024 }), /60 MiB/)
  assert.ok(storageWith(new FakeGraph(), { fragmentBytes: 16 * uploadFragmentUnit }))
})

test('arquivo já existente: recusado na criação da sessão e na conclusão, sem sobrescrever', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  const original = content(100)
  await storage.save(key, original)

  await assert.rejects(storage.save(key, content(100)), codeOf('EEXIST'))
  assert.deepEqual(graph.files.get(graph.pathOf(key)), original)

  // Outro processo grava o mesmo caminho enquanto a sessão está aberta: a conclusão falha.
  const raced = randomUUID()
  graph.fail(/^PUT https:\/\/slm-ficticio/, () => {
    graph.files.set(graph.pathOf(raced), Buffer.from('de outro'))
    return json(409, { error: { code: 'nameAlreadyExists' } })
  })
  await assert.rejects(storage.save(raced, content(100)), codeOf('EEXIST'))
  assert.equal(graph.files.get(graph.pathOf(raced))?.toString(), 'de outro')
  assert.equal(graph.openSessions(), 0, 'a sessão interrompida é cancelada')
})

test('falha durante o upload: a sessão é cancelada e nada fica na biblioteca', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph, { maxAttempts: 3 })
  const key = randomUUID()
  graph.fail(/^PUT https:\/\/slm-ficticio/, () => 'network', 10)

  const error = await storage.save(key, content(uploadFragmentUnit * 2)).catch((caught) => caught)
  codeOf('GRAPH_NETWORK')(error)
  assertNoSecretIn(error, graph)
  assert.equal(graph.files.has(graph.pathOf(key)), false)
  assert.equal(graph.openSessions(), 0)
  assert.ok(graph.requests.some((request) => request.method === 'DELETE' && request.url.includes('/upload/')))
})

test('falha passageira em uma parte: nova tentativa e continuação pelo ponto informado', async () => {
  const graph = new FakeGraph()
  const file = content(uploadFragmentUnit * 3)

  // 503 em uma parte: a mesma parte é repetida.
  const first = randomUUID()
  graph.fail(/^PUT https:\/\/slm-ficticio/, () => json(503, { error: { code: 'serviceNotAvailable' } }))
  await storageWith(graph).save(first, file)
  assert.deepEqual(graph.files.get(graph.pathOf(first)), file)

  // A parte chegou, mas a resposta se perdeu: a repetição recebe 416 e a sessão diz onde seguir.
  let lost = false
  const flaky = async (input: string, init?: RequestInit) => {
    const response = await graph.fetch(input, init)
    if (init?.method === 'PUT' && response.status === 202 && !lost) {
      lost = true
      throw new TypeError('fetch failed')
    }
    return response
  }
  const second = randomUUID()
  await storageWith(graph, { fetcher: flaky }).save(second, file)
  assert.deepEqual(graph.files.get(graph.pathOf(second)), file)
  assert.ok(graph.requests.some((request) => request.method === 'GET' && request.url.includes('/upload/')), 'consultou a sessão')
  assert.equal(graph.openSessions(), 0)
})

test('integridade: tamanho diferente na conclusão retira o arquivo e recusa o envio', async () => {
  const graph = new FakeGraph()
  graph.reportWrongSize = true
  const key = randomUUID()
  await assert.rejects(storageWith(graph).save(key, content(500)), codeOf('GRAPH_INTEGRITY'))
  assert.equal(graph.files.has(graph.pathOf(key)), false)
})

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

test('download: pelo servidor, seguindo a URL temporária sem o token', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  const file = content(uploadFragmentUnit + 10)
  await storage.save(key, file)

  assert.deepEqual(await readAll(await storage.open(key)), file)
  const content_ = graph.requests.find((request) => request.url.endsWith(':/content'))!
  assert.match(content_.authorization ?? '', /^Bearer /)
  const temporary = graph.requests.find((request) => request.url.includes('/download/'))!
  assert.equal(temporary.authorization, null, 'o token não vai para a URL temporária')

  await assert.rejects(storage.open(randomUUID()), codeOf('ENOENT'))
  await assert.rejects(storage.open('../../segredo'), /inválida/)
})

test('SHA-256 divergente: o conteúdo alterado no SharePoint não chega inteiro', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  const file = content(2000)
  await storage.save(key, file)
  const expected = { sha256: createHash('sha256').update(file).digest('hex'), sizeBytes: file.length }

  // Íntegro: passa.
  const received: Buffer[] = []
  await pipeline(await storage.open(key), verifyContent(expected), async function* (source) {
    for await (const chunk of source) received.push(chunk as Buffer)
  })
  assert.deepEqual(Buffer.concat(received), file)

  // Corrompido (mesmo tamanho) ou truncado: erro, e nenhum byte sai antes da conferência.
  for (const corrupted of [Buffer.concat([file.subarray(0, 1999), Buffer.from([file[1999] ^ 1])]), file.subarray(0, 1000)]) {
    graph.files.set(graph.pathOf(key), corrupted)
    const delivered: Buffer[] = []
    await assert.rejects(
      pipeline(await storage.open(key), verifyContent(expected), async function* (source) {
        for await (const chunk of source) delivered.push(chunk as Buffer)
      }),
      AttachmentIntegrityError,
    )
    assert.equal(Buffer.concat(delivered).length, 0)
  }
})

test('download parado: interrompido pelo limite de tempo', async () => {
  const graph = new FakeGraph()
  const key = randomUUID()
  await storageWith(graph).save(key, content(10))
  graph.fail(/^GET https:\/\/slm-ficticio\.sharepoint\.com\/download/, () => {
    const body = new ReadableStream({ start() {} }) // nunca envia dados
    return new Response(body, { status: 200 })
  })
  const stream = await storageWith(graph, { timeoutMs: 50 }).open(key)
  await assert.rejects(readAll(stream), codeOf('GRAPH_TIMEOUT'))
})

test('limite de tempo sem resposta: novas tentativas e erro sem detalhes', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph, { timeoutMs: 20, maxAttempts: 2 })
  graph.fail(/^GET https:\/\/graph\.microsoft\.com/, () => 'hang', 2)
  const error = await storage.check().catch((caught) => caught)
  codeOf('GRAPH_TIMEOUT')(error)
  assertNoSecretIn(error, graph)
})

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------

test('falha de autenticação: credencial recusada, sem chamar a biblioteca e sem segredo no erro', async () => {
  const graph = new FakeGraph()
  graph.rejectCredentials = true
  const error = await storageWith(graph).save(randomUUID(), content(10)).catch((caught) => caught)
  codeOf('GRAPH_AUTH_FAILED')(error)
  assert.equal(error.retryable, false)
  assertNoSecretIn(error, graph)
  assert.equal(graph.graphCalls().length, 0)
})

test('token expirado: renovado antes do vencimento e, se revogado, uma única vez após 401', async () => {
  const graph = new FakeGraph()
  graph.tokenSeconds = 600
  const storage = storageWith(graph)
  await storage.check()
  assert.equal(graph.issuedTokens.length, 1)

  // Dentro da folga de cinco minutos: renova antes de usar.
  graph.clock += 6 * 60_000
  await storage.check()
  assert.equal(graph.issuedTokens.length, 2)

  // Revogado no servidor: 401, token novo e a mesma chamada repetida.
  graph.revokeTokens()
  await storage.check()
  assert.equal(graph.issuedTokens.length, 3)

  // 401 persistente: não insiste.
  graph.fail(/^GET https:\/\/graph\.microsoft\.com/, () => json(401, { error: { code: 'InvalidAuthenticationToken' } }), 5)
  await assert.rejects(storage.check(), codeOf('GRAPH_AUTH_REJECTED'))
  assert.equal(graph.issuedTokens.length, 4)
})

test('renovações simultâneas pedem um único token', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  await Promise.all([storage.check(), storage.check(), storage.check()])
  assert.equal(graph.issuedTokens.length, 1)
})

test('sem permissão no site (Sites.Selected ausente): 403 não é repetido', async () => {
  const graph = new FakeGraph()
  graph.fail(/^GET https:\/\/graph\.microsoft\.com/, () => json(403, { error: { code: 'accessDenied' } }), 5)
  await assert.rejects(storageWith(graph).check(), codeOf('GRAPH_FORBIDDEN'))
  assert.equal(graph.graphCalls().length, 1)
})

test('certificado: asserção assinada RS256, com x5t, sem enviar segredo', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const thumbprint = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const credentials = { kind: 'certificate' as const, tenantId: fakeTenant, clientId: fakeClient, privateKey: pem, thumbprint }

  const assertion = buildClientAssertion(credentials, 1_800_000_000)
  const [header, payload, signature] = assertion.split('.')
  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString())
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  assert.equal(decodedHeader.alg, 'RS256')
  assert.equal(Buffer.from(decodedHeader.x5t, 'base64url').toString('hex'), thumbprint)
  assert.equal(claims.aud, `https://login.microsoftonline.com/${fakeTenant}/oauth2/v2.0/token`)
  assert.equal(claims.iss, fakeClient)
  assert.equal(claims.sub, fakeClient)
  assert.equal(claims.exp - claims.iat, 600)
  assert.ok(
    createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')),
  )

  const graph = new FakeGraph()
  const storage = new GraphDriveStorage({ ...fakeSettings, credentials }, { fetcher: graph.fetch, now: graph.now, sleep: graph.sleep })
  await storage.check()
  const form = new URLSearchParams(graph.requests[0].body!.toString())
  assert.equal(form.has('client_secret'), false)
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
})

// ---------------------------------------------------------------------------
// Limites do serviço
// ---------------------------------------------------------------------------

test('429: respeita Retry-After e conclui', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  graph.fail(/:\/createUploadSession$/, () => json(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '3' }), 2)
  await storage.save(key, content(10))
  assert.deepEqual(graph.sleeps, [3000, 3000])
  assert.ok(graph.files.has(graph.pathOf(key)))
})

test('429: espera longa demais ou tentativas esgotadas falham logo, sem segurar a pessoa', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph, { maxAttempts: 3 })
  graph.fail(/:\/createUploadSession$/, () => json(429, {}, { 'retry-after': '120' }))
  await assert.rejects(storage.save(randomUUID(), content(10)), codeOf('GRAPH_THROTTLED'))
  assert.deepEqual(graph.sleeps, [])

  graph.fail(/:\/createUploadSession$/, () => json(429, {}, { 'retry-after': '1' }), 3)
  await assert.rejects(storage.save(randomUUID(), content(10)), codeOf('GRAPH_THROTTLED'))
  assert.deepEqual(graph.sleeps, [1000, 1000])
})

test('503: espera crescente sem Retry-After, e indisponibilidade persistente vira erro', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph, { maxAttempts: 4 })
  const key = randomUUID()
  await storage.save(key, content(10))

  graph.fail(/:\/content$/, () => json(503, { error: { code: 'serviceNotAvailable' } }), 2)
  assert.equal((await readAll(await storage.open(key))).length, 10)
  assert.deepEqual(graph.sleeps, [1000, 2000])

  graph.fail(/:\/content$/, () => json(503, {}), 4)
  const error = await storage.open(key).catch((caught) => caught)
  codeOf('GRAPH_UNAVAILABLE')(error)
  assert.equal(error.retryable, true)
})

test('Retry-After: segundos ou data HTTP', () => {
  assert.equal(retryAfterMs('5', 0), 5000)
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000)
  assert.equal(retryAfterMs('amanhã', 0), null)
  assert.equal(retryAfterMs(null, 0), null)
})

// ---------------------------------------------------------------------------
// Remoção e reversão
// ---------------------------------------------------------------------------

const actor = { userId: randomUUID(), permissions: [], slmMember: false, sector: 'TI' } as unknown as AuthenticatedIdentity

/** Banco falso: a capacidade responde, mas a gravação do registro falha. */
function poolRejectingInsert() {
  const query = async (text: string) => {
    if (/INSERT INTO public\.request_attachments/.test(text)) throw Object.assign(new Error('recusado'), { code: '23503' })
    if (/sum\(tamanho_bytes\)/.test(text)) return { rows: [{ total: '0', arquivos: 0 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  return { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool
}

test('reversão de envio: banco recusa o registro e o arquivo é removido do SharePoint', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const repository = new AttachmentRepository(poolRejectingInsert)
  await assert.rejects(
    repository.add(actor, storage, { type: 'service_request', id: randomUUID() }, {
      content: content(50),
      name: 'foto.png',
      kind: 'png',
      category: 'outro',
      restricted: false,
      maxTotalBytes: 10_000_000,
    }),
    /persistência/,
  )
  assert.equal(graph.files.size, 0)
  const deleted = graph.requests.filter((request) => request.method === 'DELETE' && request.url.includes('graph.microsoft.com'))
  assert.equal(deleted.length, 1)
  assert.match(deleted[0].authorization ?? '', /^Bearer /)
})

test('remove: só apaga o caminho da chave; já ausente não é erro', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  await storage.save(key, content(10))
  await storage.remove(key)
  assert.equal(graph.files.has(graph.pathOf(key)), false)
  await storage.remove(key)
  await assert.rejects(storage.remove('..'), /inválida/)
})

test('nenhum link de compartilhamento, convite ou permissão é criado', async () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  const key = randomUUID()
  await storage.save(key, content(10))
  await readAll(await storage.open(key))
  await storage.remove(key)
  await storage.check()
  for (const request of graph.requests) {
    assert.doesNotMatch(request.url, /createLink|invite|permissions|grant/i)
  }
})

// ---------------------------------------------------------------------------
// Configuração e seleção
// ---------------------------------------------------------------------------

const sharepointEnvironment = {
  ATTACHMENTS_STORAGE: 'sharepoint',
  GRAPH_TENANT_ID: fakeTenant,
  GRAPH_CLIENT_ID: fakeClient,
  GRAPH_CLIENT_SECRET: fakeSecret,
  SHAREPOINT_DRIVE_ID: fakeDrive,
}

test('ausência de credenciais: sem armazenamento, sem cair para o disco local, e erro na conferência', () => {
  const missing = { ATTACHMENTS_STORAGE: 'sharepoint', ATTACHMENTS_DIR: '/var/lib/slm/anexos' }
  assert.equal(resolveAttachmentStorage(missing), null)
  const findings = checkEnvironment(missing)
  for (const variable of ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET / GRAPH_CERTIFICATE_*', 'SHAREPOINT_DRIVE_ID']) {
    assert.equal(findings.find((finding) => finding.variable === variable)?.level, 'erro', variable)
  }

  const settings = graphStorageSettings({ ...sharepointEnvironment, GRAPH_CLIENT_SECRET: '' })
  assert.equal(settings.ok, false)
  assert.equal(resolveAttachmentStorage({ ATTACHMENTS_STORAGE: 'nuvem-qualquer', ATTACHMENTS_DIR: '/var/lib/slm/anexos' }), null)
  assert.equal(checkEnvironment({ ATTACHMENTS_STORAGE: 'nuvem' }).find((item) => item.variable === 'ATTACHMENTS_STORAGE')?.level, 'erro')
})

test('configuração: valores validados, segredo e certificado alternativos, e nada exposto', () => {
  assert.equal(resolveAttachmentStorage(sharepointEnvironment) instanceof GraphDriveStorage, true)
  assert.equal(resolveAttachmentStorage(sharepointEnvironment), resolveAttachmentStorage(sharepointEnvironment), 'mesma instância, mesmo token')

  const problems = (extra: Record<string, string>) => {
    const result = graphStorageSettings({ ...sharepointEnvironment, ...extra })
    return result.ok ? [] : result.problems.map((problem) => problem.variable)
  }
  assert.deepEqual(problems({ GRAPH_TENANT_ID: 'x/../../evil' }), ['GRAPH_TENANT_ID'])
  assert.deepEqual(problems({ GRAPH_CLIENT_ID: 'nao-e-guid' }), ['GRAPH_CLIENT_ID'])
  assert.deepEqual(problems({ SHAREPOINT_DRIVE_ID: 'b!/../outro' }), ['SHAREPOINT_DRIVE_ID'])
  assert.deepEqual(problems({ SHAREPOINT_ROOT_FOLDER: '../fora' }), ['SHAREPOINT_ROOT_FOLDER'])
  assert.deepEqual(problems({ SHAREPOINT_ROOT_FOLDER: 'SLM/Anexos' }), [])
  assert.deepEqual(problems({ GRAPH_CERTIFICATE_THUMBPRINT: 'a'.repeat(40) }), ['GRAPH_CLIENT_SECRET / GRAPH_CERTIFICATE_*'])
  assert.deepEqual(
    problems({ GRAPH_CLIENT_SECRET: '', GRAPH_CERTIFICATE_PRIVATE_KEY: 'chave', GRAPH_CERTIFICATE_THUMBPRINT: 'curta' }),
    ['GRAPH_CERTIFICATE_PRIVATE_KEY', 'GRAPH_CERTIFICATE_THUMBPRINT'],
  )

  const findings = checkEnvironment({ ...sharepointEnvironment, NODE_ENV: 'production', ATTACHMENTS_DIR: '/var/lib/slm/anexos' })
  assert.equal(findings.find((item) => item.variable === 'ATTACHMENTS_STORAGE')?.level, 'ok')
  assert.equal(findings.find((item) => item.variable === 'GRAPH_CLIENT_SECRET')?.level, 'aviso')
  assert.equal(findings.find((item) => item.variable === 'ATTACHMENTS_DIR')?.level, 'aviso')
  const text = JSON.stringify(findings)
  for (const secret of [fakeSecret, fakeTenant, fakeClient, fakeDrive]) assert.equal(text.includes(secret), false)
})

test('armazenamento local preservado: padrão, sem sobrescrita, leitura e remoção', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'slm-local-'))
  try {
    const storage = resolveAttachmentStorage({ ATTACHMENTS_DIR: directory })
    assert.ok(storage instanceof LocalDiskStorage)
    assert.ok(resolveAttachmentStorage({ ATTACHMENTS_STORAGE: 'local', ATTACHMENTS_DIR: directory }) instanceof LocalDiskStorage)
    await storage.check()

    const key = randomUUID()
    const file = content(4000)
    await storage.save(key, file)
    await assert.rejects(storage.save(key, content(10)), (error: NodeJS.ErrnoException) => error.code === 'EEXIST')
    assert.deepEqual(readFileSync(join(directory, key.slice(0, 2), key)), file)
    assert.deepEqual(await readAll(await storage.open(key)), file)

    writeFileSync(join(directory, key.slice(0, 2), key), Buffer.alloc(4000))
    const expected = { sha256: createHash('sha256').update(file).digest('hex'), sizeBytes: file.length }
    await assert.rejects(pipeline(await storage.open(key), verifyContent(expected), async function* (source) {
      for await (const _chunk of source) yield _chunk
    }), AttachmentIntegrityError)

    await storage.remove(key)
    await assert.rejects(readAll(await storage.open(key)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('substituto de testes: só vale enquanto definido', () => {
  const graph = new FakeGraph()
  const storage = storageWith(graph)
  setAttachmentStorageForTests(storage)
  try {
    assert.equal(resolveAttachmentStorage({}), storage)
  } finally {
    setAttachmentStorageForTests(undefined)
  }
  assert.equal(resolveAttachmentStorage({}), null)
})
