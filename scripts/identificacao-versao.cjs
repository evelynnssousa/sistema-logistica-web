#!/usr/bin/env node
/**
 * Identificação SHA-256 do código-fonte da API (registro de versão da homologação).
 * Só lê: não grava arquivos, não acessa banco, não lê nem imprime variáveis de ambiente.
 * Procedimento descrito em docs/auditoria/IDENTIFICACAO_VERSAO_HOMOLOGACAO_2026-11-07.md.
 *
 *   node scripts/identificacao-versao.cjs
 *       Mostra o commit e as identificações A (commit), B (código atual) e C (só alterações locais).
 *   node scripts/identificacao-versao.cjs --esperado-b=<sha256>
 *       Também confere B com um valor registrado; sai com 1 se divergir.
 *   node scripts/identificacao-versao.cjs --lista=commit|atual|alteracoes
 *       Imprime a lista (manifesto) usada no cálculo, para comparar arquivo a arquivo.
 *
 * Método: SHA-256 de cada arquivo; linhas "<sha256>  <caminho>\n" ordenadas pelo caminho
 * (ordem de bytes); a identificação é o SHA-256 dessa lista. Mesmo resultado do cálculo
 * feito com sha256sum e LC_ALL=C sort em 07/11/2026.
 */
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync, statSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

// Não alterar sem registrar um novo procedimento: muda todas as identificações.
const SCOPE = [
  'backend/src',
  'backend/database',
  'backend/testing',
  'backend/tsconfig.json',
  'package.json',
  'package-lock.json',
  'scripts/homologacao.cjs',
]
const EXCLUDED = /(^|\/)\.env|(^|\/)dist\/|node_modules\/|^backups\//

const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: projectRoot, encoding, maxBuffer: 256 * 1024 * 1024 })
}
// -z vem logo depois do subcomando: depois de "--" o Git o leria como caminho.
const gitList = ([command, ...rest]) => git([command, '-z', ...rest]).split('\0').filter(Boolean)

function isRegularFile(path) {
  try {
    return statSync(resolve(projectRoot, path)).isFile()
  } catch {
    return false
  }
}

function manifest(entries) {
  return entries
    .filter((entry) => !EXCLUDED.test(entry.path))
    .sort((a, b) => byBytes(a.path, b.path))
    .map((entry) => `${entry.hash}  ${entry.path}\n`)
    .join('')
}

function commitManifest() {
  // "<modo> blob <id>\t<caminho>"; o conteúdo vem do objeto do Git, sem filtros.
  const entries = gitList(['ls-tree', '-r', 'HEAD', '--', ...SCOPE])
    .map((line) => {
      const [meta, path] = line.split('\t')
      return { type: meta.split(' ')[1], blob: meta.split(' ')[2], path }
    })
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, hash: sha256(git(['cat-file', 'blob', entry.blob], 'buffer')) }))
  return manifest(entries)
}

function workingTreeManifest() {
  const tracked = gitList(['ls-files', '--', ...SCOPE])
  const untracked = gitList(['ls-files', '--others', '--exclude-standard', '--', ...SCOPE])
  const paths = [...new Set([...tracked, ...untracked])].filter((path) => !EXCLUDED.test(path) && isRegularFile(path))
  return manifest(paths.map((path) => ({ path, hash: sha256(readFileSync(resolve(projectRoot, path))) })))
}

// Linhas que existem só de um lado: "HEAD <linha do commit>" e "WT   <linha atual>", por caminho.
function changesManifest(commit, current) {
  const lines = (text) => new Set(text.split('\n').filter(Boolean))
  const before = lines(commit)
  const after = lines(current)
  const pathOf = (line) => line.slice(line.indexOf('  ') + 2)
  const rows = [
    ...[...before].filter((line) => !after.has(line)).map((line) => ({ side: 'HEAD', line })),
    ...[...after].filter((line) => !before.has(line)).map((line) => ({ side: 'WT  ', line })),
  ]
  rows.sort((a, b) => byBytes(pathOf(a.line), pathOf(b.line)) || byBytes(a.side, b.side))
  return rows.map((row) => `${row.side} ${row.line}\n`).join('')
}

function summarize(changes) {
  const sides = new Map()
  for (const line of changes.split('\n').filter(Boolean)) {
    const path = line.slice(line.indexOf('  ', 5) + 2)
    const entry = sides.get(path) || new Set()
    entry.add(line.slice(0, 4).trim())
    sides.set(path, entry)
  }
  const count = (fn) => [...sides.values()].filter(fn).length
  return {
    modificados: count((s) => s.has('HEAD') && s.has('WT')),
    novos: count((s) => s.size === 1 && s.has('WT')),
    removidos: count((s) => s.size === 1 && s.has('HEAD')),
  }
}

function main() {
  const options = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
      if (!match) throw new Error(`Opção desconhecida: ${arg}`)
      return [match[1], match[2] ?? true]
    }),
  )
  const commit = commitManifest()
  const current = workingTreeManifest()
  const changes = changesManifest(commit, current)

  if (options.lista) {
    const lists = { commit, atual: current, alteracoes: changes }
    if (!(options.lista in lists)) throw new Error('Use --lista=commit, --lista=atual ou --lista=alteracoes.')
    process.stdout.write(lists[options.lista])
    return
  }

  const lineCount = (text) => text.split('\n').filter(Boolean).length
  const { modificados, novos, removidos } = summarize(changes)
  const b = sha256(current)
  console.log(`Branch            ${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}`)
  console.log(`Commit-base       ${git(['rev-parse', 'HEAD']).trim()}`)
  console.log(`A (commit)        ${sha256(commit)}  (${lineCount(commit)} arquivos)`)
  console.log(`B (código atual)  ${b}  (${lineCount(current)} arquivos)`)
  console.log(`C (alterações)    ${sha256(changes)}  (${modificados} modificados, ${novos} novos, ${removidos} removidos)`)

  if (typeof options['esperado-b'] === 'string') {
    if (options['esperado-b'] === b) {
      console.log('Conferência de B: CONFERE com o valor registrado.')
    } else {
      console.log('Conferência de B: DIVERGE do valor registrado. Compare com --lista=atual; não substitua o registro.')
      process.exitCode = 1
    }
  }
}

try {
  main()
} catch (error) {
  console.error(`Falha: ${error.message}`)
  process.exitCode = 2
}
