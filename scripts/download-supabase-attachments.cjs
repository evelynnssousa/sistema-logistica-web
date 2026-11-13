#!/usr/bin/env node
/**
 * Cópia local dos anexos guardados no Supabase Storage (ATTACHMENTS_STORAGE=supabase). O plano
 * gratuito do Supabase não faz backup dos arquivos: esta cópia, empacotada depois por
 * scripts/backup-attachments.cjs, é o backup.
 *
 *   node scripts/download-supabase-attachments.cjs --out <pasta>
 *
 * Só lê o bucket: não altera nem apaga nada nele. Na pasta de destino, baixa só o que falta ou
 * mudou de tamanho, na mesma divisão de pastas do disco local (<2 caracteres>/<chave>).
 * Usa SUPABASE_URL, SUPABASE_SECRET_KEY e SUPABASE_STORAGE_BUCKET do ambiente ou de backend/.env.
 * Os anexos são documentos institucionais e podem ter dados pessoais: a pasta precisa ficar fora
 * do projeto (não pode ir para o Git) e a cópia deve ser guardada cifrada.
 */
const { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const keyPattern = /^[0-9a-f-]{36}$/
const folderPattern = /^[0-9a-f]{2}$/

function readSettings() {
  let file = {}
  const envFile = resolve(projectRoot, 'backend/.env')
  if (existsSync(envFile)) file = require('dotenv').parse(readFileSync(envFile))
  const pick = (name) => (process.env[name]?.trim() || file[name]?.trim() || '')
  const url = pick('SUPABASE_URL').replace(/\/+$/, '')
  const key = pick('SUPABASE_SECRET_KEY')
  const bucket = pick('SUPABASE_STORAGE_BUCKET') || 'slm-anexos'
  if (!/^https:\/\/[^/]+$/.test(url)) throw new Error('SUPABASE_URL ausente ou inválida (ex.: https://abcdefgh.supabase.co).')
  if (!key) throw new Error('SUPABASE_SECRET_KEY ausente.')
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket)) throw new Error('SUPABASE_STORAGE_BUCKET inválido.')
  return { url, key, bucket }
}

function headers(key, extra = {}) {
  const result = { apikey: key, ...extra }
  if (key.startsWith('eyJ')) result.authorization = `Bearer ${key}`
  return result
}

async function call(settings, path, init = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch(`${settings.url}/storage/v1/${path}`, {
        ...init,
        headers: headers(settings.key, init.headers),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      if (attempt >= 3) throw new Error('Sem conexão com o Supabase.')
      await new Promise((done) => setTimeout(done, 1000 * attempt))
      continue
    }
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await response.body?.cancel()
      await new Promise((done) => setTimeout(done, 1000 * attempt))
      continue
    }
    // A mensagem nunca traz a chave nem o endereço completo.
    if (response.status === 401 || response.status === 403) throw new Error('Chave recusada pelo Supabase.')
    if (!response.ok) throw new Error(`O Supabase respondeu ${response.status}.`)
    return response
  }
}

async function list(settings, prefix) {
  const entries = []
  for (let offset = 0; ; offset += 1000) {
    const response = await call(settings, `object/list/${encodeURIComponent(settings.bucket)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    const page = await response.json()
    if (!Array.isArray(page)) throw new Error('Resposta inesperada do Supabase.')
    entries.push(...page)
    if (page.length < 1000) return entries
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--out') throw new Error('Uso: node scripts/download-supabase-attachments.cjs --out <pasta>')
  const destination = resolve(args[1])
  const inside = relative(projectRoot, destination)
  if (!inside.startsWith('..') && !isAbsolute(inside)) {
    throw new Error('A pasta de destino não pode ficar dentro do projeto: os documentos poderiam ir para o Git.')
  }
  const settings = readSettings()
  mkdirSync(destination, { recursive: true, mode: 0o700 })

  // Bucket público nunca deveria existir; o aviso ajuda a perceber o erro de configuração.
  const bucket = await (await call(settings, `bucket/${encodeURIComponent(settings.bucket)}`)).json()
  if (bucket.public !== false) console.warn('ATENÇÃO: o bucket está PÚBLICO. Torne-o privado no painel do Supabase.')

  let downloaded = 0
  let kept = 0
  let bytes = 0
  for (const folder of await list(settings, '')) {
    // Pastas aparecem sem id. Qualquer coisa fora do padrão do SLM é ignorada.
    if (folder.id !== null || !folderPattern.test(folder.name)) continue
    for (const item of await list(settings, `${folder.name}/`)) {
      if (!item.id || !keyPattern.test(item.name) || !item.name.startsWith(folder.name)) continue
      const target = join(destination, folder.name, item.name)
      if (!target.startsWith(destination + sep)) continue
      const size = Number(item.metadata?.size)
      if (existsSync(target) && statSync(target).size === size) {
        kept += 1
        continue
      }
      const response = await call(settings, `object/authenticated/${encodeURIComponent(settings.bucket)}/${folder.name}/${item.name}`)
      const content = Buffer.from(await response.arrayBuffer())
      if (Number.isFinite(size) && content.length !== size) throw new Error(`Tamanho divergente no anexo ${item.name}.`)
      mkdirSync(join(destination, folder.name), { recursive: true, mode: 0o700 })
      // Grava ao lado e renomeia: uma cópia interrompida nunca fica pela metade com o nome final.
      writeFileSync(`${target}.parcial`, content, { mode: 0o600 })
      renameSync(`${target}.parcial`, target)
      downloaded += 1
      bytes += content.length
    }
  }
  console.log(`Baixados: ${downloaded} (${bytes} bytes). Já presentes: ${kept}.`)
  console.log('Agora gere o pacote do backup com:')
  console.log(`  ATTACHMENTS_DIR="${destination}" npm run backup:attachments`)
}

main().catch((error) => {
  console.error(`Falha: ${error.message}`)
  process.exitCode = 1
})
