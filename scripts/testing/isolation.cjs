/**
 * Regras comuns aos executores de teste. Nada aqui encerra processos de terceiros:
 * só são encerrados os processos e containers iniciados pelo próprio executor.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const net = require('node:net')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..', '..')
const remoteBlockPath = resolve(projectRoot, 'backend/testing/block-remote-connections.cjs')

// Portas do desenvolvimento, ligadas ao banco real. Testes nunca as utilizam.
const sharedPorts = Object.freeze([3000, 5173])

const testPorts = Object.freeze({
  browserApi: 3901,
  browserFrontend: 5901,
  browserDatabase: 55901,
  integrationDatabase: 55902,
  backupDatabase: 55903,
  // Ambiente demonstrativo (npm run demo:demandas), com o mesmo isolamento.
  demoApi: 3910,
  demoFrontend: 5910,
  demoDatabase: 55910,
})

function describeListener(port) {
  try {
    const output = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' })
    const line = output.split('\n').find((item) => item.includes(`:${port} `))
    const pid = line?.match(/pid=(\d+)/)?.[1]
    const name = line?.match(/users:\(\("([^"]+)"/)?.[1]
    return pid ? `pid ${pid} (${name ?? 'processo'})` : 'um processo não identificado'
  } catch {
    return 'um processo não identificado'
  }
}

function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '0.0.0.0')
  })
}

/** Para a execução se uma porta estiver em uso. Nunca reutiliza nem encerra o ocupante. */
async function assertPortsFree(ports) {
  for (const port of ports) {
    if (sharedPorts.includes(port)) {
      throw new Error(`A porta ${port} é do desenvolvimento e não pode ser usada em testes.`)
    }
    if (!(await isPortFree(port))) {
      throw new Error(
        `A porta ${port}, reservada aos testes, está ocupada por ${describeListener(port)}. ` +
          'Nada foi encerrado nem reutilizado. Libere a porta e rode de novo.',
      )
    }
  }
}

/**
 * Ambiente mínimo para os processos de teste: nada é herdado além do necessário,
 * então DATABASE_URL, chaves e demais segredos do terminal não chegam a eles.
 */
function isolatedEnvironment(extra = {}) {
  const environment = {
    NODE_ENV: 'test',
    NODE_OPTIONS: `--require=${remoteBlockPath}`,
  }

  for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }

  return { ...environment, ...extra }
}

function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options })
  if (result.error) {
    throw new Error('Docker não está disponível. Ele é necessário para o banco descartável.')
  }
  return result
}

/** Cria um PostgreSQL em memória, só na interface local, com senha nova a cada execução. */
async function startDisposablePostgres({ port, database }) {
  if (!database.endsWith('_test')) {
    throw new Error('O banco descartável precisa ter nome terminado em _test.')
  }

  const password = randomBytes(24).toString('hex')
  const name = `slm-teste-${randomBytes(6).toString('hex')}`
  const started = runDocker(
    [
      'run', '-d', '--rm', '--name', name,
      '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${database}`,
      '-p', `127.0.0.1:${port}:5432`,
      '--tmpfs', '/var/lib/postgresql/data',
      'postgres:17',
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  )
  if (started.status !== 0) {
    throw new Error('Não foi possível iniciar o banco descartável no Docker.')
  }

  const stop = () => {
    runDocker(['stop', name], { stdio: 'ignore' })
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = runDocker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database])
    if (ready.status === 0) {
      // O pg_isready responde antes de o banco final terminar de iniciar.
      await new Promise((done) => setTimeout(done, 1500))
      return { url: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`, stop }
    }
    await new Promise((done) => setTimeout(done, 500))
  }

  stop()
  throw new Error('O banco descartável não ficou pronto a tempo.')
}

module.exports = {
  assertPortsFree,
  isPortFree,
  isolatedEnvironment,
  projectRoot,
  remoteBlockPath,
  sharedPorts,
  startDisposablePostgres,
  testPorts,
}
