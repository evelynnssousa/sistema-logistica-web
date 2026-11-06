#!/usr/bin/env node
/**
 * Testa o backup e a restauração dos anexos só com arquivos fictícios, em pastas temporárias.
 * Não lê backend/.env nem a pasta de anexos real.
 */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

function run(script, args, environment) {
  return spawnSync(process.execPath, [resolve(projectRoot, 'scripts', script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...environment },
  })
}

function main() {
  const root = mkdtempSync(join(tmpdir(), 'slm-teste-anexos-'))
  try {
    const source = join(root, 'anexos')
    const out = join(root, 'copias')
    const log = join(root, 'registro.jsonl')
    mkdirSync(join(source, 'ab'), { recursive: true })
    mkdirSync(join(source, 'cd'), { recursive: true })
    writeFileSync(join(source, 'ab', 'ab000000-0000-4000-8000-000000000001'), '%PDF-1.4 documento fictício')
    writeFileSync(join(source, 'cd', 'cd000000-0000-4000-8000-000000000002'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const before = readFileSync(join(source, 'ab', 'ab000000-0000-4000-8000-000000000001'))

    const missing = run('backup-attachments.cjs', ['--out', out], {})
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /informe ATTACHMENTS_DIR/)
    console.log('✔ em teste, sem ATTACHMENTS_DIR explícita, recusa e não lê o .env')

    const inside = run('backup-attachments.cjs', ['--out', join(source, 'copia')], { ATTACHMENTS_DIR: source })
    assert.equal(inside.status, 1)
    assert.match(inside.stderr, /não pode ficar dentro da pasta de anexos/)
    console.log('✔ destino dentro da pasta de anexos é recusado')

    const backup = run('backup-attachments.cjs', ['--out', out], { ATTACHMENTS_DIR: source, BACKUP_LOG_PATH: log })
    assert.equal(backup.status, 0, backup.stderr)
    assert.match(backup.stdout, /Anexos copiados: 2/)
    const archive = /Arquivo: (.+)/.exec(backup.stdout)[1].trim()
    assert.equal(statSync(archive).mode & 0o777, 0o600)
    assert.equal(statSync(`${archive}.manifesto.json`).mode & 0o777, 0o600)
    assert.deepEqual(readFileSync(join(source, 'ab', 'ab000000-0000-4000-8000-000000000001')), before, 'a origem não muda')
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }).stdout
    assert.ok(!listing.includes(source), 'o pacote não leva caminhos absolutos')
    const entry = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop())
    assert.deepEqual([entry.type, entry.ok, entry.arquivos], ['backup_anexos', true, 2])
    assert.ok(!JSON.stringify(entry).includes(root), 'o registro não traz caminhos')
    console.log('✔ gera pacote, manifesto e SHA-256 com permissão 600, sem alterar a origem')

    const verified = run('verify-attachments-backup.cjs', [archive], {})
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /Restauração conferida: 2 arquivo/)
    console.log('✔ restauração em pasta temporária confere o SHA-256 de cada arquivo')

    const target = join(root, 'restaurado')
    mkdirSync(target)
    const restored = run('verify-attachments-backup.cjs', [archive, '--restaurar-em', target], {})
    assert.equal(restored.status, 0, restored.stderr)
    assert.deepEqual(readFileSync(join(target, 'ab', 'ab000000-0000-4000-8000-000000000001')), before)
    const again = run('verify-attachments-backup.cjs', [archive, '--restaurar-em', target], {})
    assert.equal(again.status, 1)
    assert.match(again.stderr, /precisa estar vazia/)
    console.log('✔ restauração real só em pasta vazia, com conteúdo idêntico')

    const manifest = JSON.parse(readFileSync(`${archive}.manifesto.json`, 'utf8'))
    manifest.arquivos[0].sha256 = '0'.repeat(64)
    writeFileSync(`${archive}.manifesto.json`, JSON.stringify(manifest))
    const changedFile = run('verify-attachments-backup.cjs', [archive], {})
    assert.equal(changedFile.status, 1)
    assert.match(changedFile.stderr, /conteúdo diferente/)
    appendFileSync(archive, 'x')
    const tampered = run('verify-attachments-backup.cjs', [archive], {})
    assert.equal(tampered.status, 1)
    assert.match(tampered.stderr, /SHA-256 do pacote não confere/)
    console.log('✔ pacote ou arquivo adulterado é reprovado')

    symlinkSync('/etc/hostname', join(source, 'ab', 'ligacao'))
    const linked = run('backup-attachments.cjs', ['--out', out], { ATTACHMENTS_DIR: source })
    assert.equal(linked.status, 1)
    assert.match(linked.stderr, /ligação simbólica/)
    assert.equal(readdirSync(out).filter((name) => name.endsWith('.tar.gz')).length, 1, 'nenhum pacote novo')
    console.log('✔ ligação simbólica na pasta é recusada')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

try {
  main()
  console.log('Teste do backup de anexos concluído.')
} catch (error) {
  console.error(`Teste interrompido: ${error.message}`)
  process.exitCode = 1
}
