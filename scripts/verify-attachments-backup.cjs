#!/usr/bin/env node
/**
 * Confere uma cópia dos anexos gerada por backup-attachments.cjs: o SHA-256 do pacote, a
 * restauração completa em uma pasta temporária e o SHA-256 de cada arquivo restaurado.
 * Nunca escreve na pasta de anexos em uso. A pasta temporária é apagada ao fim.
 *
 *   node scripts/verify-attachments-backup.cjs <arquivo.tar.gz>
 *   node scripts/verify-attachments-backup.cjs <arquivo.tar.gz> --restaurar-em <pasta-vazia>
 *       Restaura de verdade na pasta indicada, que precisa existir e estar vazia.
 *
 * Saída 0 só quando todos os arquivos conferem.
 */
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, relative } = require('node:path')

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

function listFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(relative(root, path))
    }
  }
  walk(root)
  return files.sort()
}

function main() {
  const args = process.argv.slice(2)
  const archive = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null
  const targetIndex = args.indexOf('--restaurar-em')
  const target = targetIndex >= 0 ? args[targetIndex + 1] : null
  if (!archive || (targetIndex >= 0 && !target) || args.length !== (targetIndex >= 0 ? 3 : 1)) {
    throw new Error('Uso: node scripts/verify-attachments-backup.cjs <arquivo.tar.gz> [--restaurar-em <pasta-vazia>]')
  }
  if (!existsSync(archive)) throw new Error('Arquivo não encontrado.')
  if (!existsSync(`${archive}.manifesto.json`)) throw new Error('Manifesto não encontrado ao lado do arquivo.')

  const manifest = JSON.parse(readFileSync(`${archive}.manifesto.json`, 'utf8'))
  const digest = sha256(readFileSync(archive))
  if (digest !== manifest.pacoteSha256) throw new Error('O SHA-256 do pacote não confere: a cópia foi alterada ou está incompleta.')
  console.log(`SHA-256 do pacote confere: ${digest}`)

  let destination
  let temporary = false
  if (target) {
    destination = resolve(target)
    if (!existsSync(destination) || !statSync(destination).isDirectory()) throw new Error('A pasta de restauração não existe.')
    if (readdirSync(destination).length > 0) throw new Error('A pasta de restauração precisa estar vazia.')
  } else {
    destination = mkdtempSync(join(tmpdir(), 'slm-restaura-anexos-'))
    temporary = true
  }

  try {
    // Antes de extrair: nenhum item com caminho absoluto, "..", ligação ou dispositivo.
    const listing = spawnSync('tar', ['-tzvf', archive], { encoding: 'utf8' })
    if (listing.status !== 0) throw new Error('Falha ao ler o pacote.')
    for (const line of listing.stdout.split('\n').filter(Boolean)) {
      const name = line.split(/\s+/).slice(5).join(' ')
      if (!/^[-d]/.test(line) || name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error('O pacote tem um item fora do padrão dos anexos. Nada foi restaurado.')
      }
    }
    // O GNU tar já remove a barra inicial; --no-same-owner mantém o dono de quem restaura.
    const tar = spawnSync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner'], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error('Falha ao extrair o pacote.')

    const expected = new Map(manifest.arquivos.map((item) => [item.caminho, item]))
    const restored = listFiles(destination)
    const problems = []
    for (const file of restored) if (!expected.has(file)) problems.push(`arquivo a mais: ${file}`)
    for (const [file, item] of expected) {
      const path = join(destination, file)
      if (!existsSync(path)) {
        problems.push(`ausente: ${file}`)
        continue
      }
      const content = readFileSync(path)
      if (content.length !== item.bytes || sha256(content) !== item.sha256) problems.push(`conteúdo diferente: ${file}`)
    }
    if (problems.length > 0) {
      for (const problem of problems.slice(0, 20)) console.error(`PROBLEMA  ${problem}`)
      throw new Error(`${problems.length} problema(s) na restauração.`)
    }
    console.log(`Restauração conferida: ${expected.size} arquivo(s), todos com o SHA-256 do manifesto.`)
    if (target) console.log(`Arquivos restaurados em: ${destination}`)
  } finally {
    if (temporary) rmSync(destination, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`Falha: ${error.message}`)
  process.exitCode = 1
}
