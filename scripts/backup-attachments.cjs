#!/usr/bin/env node
/**
 * Backup dos anexos (pasta ATTACHMENTS_DIR), que ficam fora do banco e do pg_dump.
 * Gera um .tar.gz, um manifesto com o SHA-256 de cada arquivo e o SHA-256 do pacote.
 * Só lê a pasta de anexos: não altera, move nem apaga nenhum arquivo dela.
 *
 *   node scripts/backup-attachments.cjs                 destino padrão: backups/
 *   node scripts/backup-attachments.cjs --out <pasta>   outro destino
 *
 * Usa ATTACHMENTS_DIR do ambiente ou, na falta dela, de backend/.env. Os anexos são documentos
 * institucionais e podem ter dados pessoais: guarde a cópia cifrada, fora do servidor.
 * Para conferir e testar a restauração: node scripts/verify-attachments-backup.cjs <arquivo>.
 */
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { basename, isAbsolute, join, relative, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)

function readAttachmentsDir() {
  if (process.env.ATTACHMENTS_DIR?.trim()) return process.env.ATTACHMENTS_DIR.trim()
  if (isTestRun) throw new Error('Recusado: em teste, informe ATTACHMENTS_DIR explicitamente.')
  const envFile = resolve(projectRoot, 'backend/.env')
  if (!existsSync(envFile)) throw new Error('ATTACHMENTS_DIR não definida.')
  const { parse } = require('dotenv')
  const value = parse(readFileSync(envFile)).ATTACHMENTS_DIR
  if (!value?.trim()) throw new Error('ATTACHMENTS_DIR não definida: não há anexos a copiar.')
  return value.trim()
}

/** Registro lido pela tela de Monitoramento, como o do backup do banco. Sem caminhos. */
function recordRun(entry) {
  const path = process.env.BACKUP_LOG_PATH?.trim()
  if (!path) return
  appendFileSync(path, `${JSON.stringify({ type: 'backup_anexos', at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

/** Lista os arquivos comuns da pasta, em ordem estável. Ligações simbólicas são recusadas. */
function listFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Há uma ligação simbólica na pasta de anexos. Confira a pasta antes do backup.')
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(root, path))
    }
  }
  walk(root)
  return files
}

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const unknown = args.filter((arg, index) => arg !== '--out' && index !== outIndex + 1)
  if (unknown.length > 0 || (outIndex >= 0 && !args[outIndex + 1])) {
    throw new Error('Uso: node scripts/backup-attachments.cjs [--out <pasta>]')
  }
  const source = readAttachmentsDir()
  if (!isAbsolute(source)) throw new Error('ATTACHMENTS_DIR precisa ser um caminho absoluto.')
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error('A pasta de anexos não existe.')

  const destination = resolve(outIndex >= 0 ? args[outIndex + 1] : resolve(projectRoot, 'backups'))
  const relativeToSource = relative(resolve(source), destination)
  if (!relativeToSource.startsWith('..') && !isAbsolute(relativeToSource)) {
    throw new Error('O destino não pode ficar dentro da pasta de anexos.')
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 })

  const files = listFiles(source)
  const manifest = {
    criadoEm: new Date().toISOString(),
    arquivos: files.map((file) => {
      const content = readFileSync(join(source, file))
      return { caminho: file, bytes: content.length, sha256: sha256(content) }
    }),
  }

  const stamp = manifest.criadoEm.replace(/[:.]/g, '-')
  const archive = join(destination, `slm-anexos-${stamp}.tar.gz`)
  // Lista explícita, relativa à pasta: o pacote nunca leva caminhos absolutos do servidor.
  const listFile = join(destination, `.slm-anexos-${stamp}.lista`)
  writeFileSync(listFile, files.join('\n') + (files.length ? '\n' : ''), { mode: 0o600 })
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, '--no-recursion', '-T', listFile], { encoding: 'utf8' })
  require('node:fs').rmSync(listFile, { force: true })
  if (tar.status !== 0) {
    recordRun({ ok: false, etapa: 'pacote' })
    throw new Error('Falha ao gerar o pacote dos anexos.')
  }
  chmodSync(archive, 0o600)

  const digest = sha256(readFileSync(archive))
  manifest.pacoteSha256 = digest
  writeFileSync(`${archive}.manifesto.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`, { mode: 0o600 })

  const total = manifest.arquivos.reduce((sum, item) => sum + item.bytes, 0)
  recordRun({ ok: true, arquivos: files.length, bytes: total })
  console.log(`Arquivo: ${archive}`)
  console.log(`SHA-256: ${digest}`)
  console.log(`Anexos copiados: ${files.length} (${total} bytes)`)
  console.log('Teste a restauração com: node scripts/verify-attachments-backup.cjs <arquivo>')
}

try {
  main()
} catch (error) {
  console.error(`Falha: ${error.message}`)
  process.exitCode = 1
}
