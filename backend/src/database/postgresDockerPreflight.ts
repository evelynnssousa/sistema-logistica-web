import { assertLocalDockerDaemon } from './postgresTestGuard.js'

try {
  const endpoint = assertLocalDockerDaemon()
  process.stdout.write(`${endpoint}\n`)
} catch {
  process.stderr.write(
    'Preflight Docker bloqueado: não foi possível comprovar um socket Unix local.\n',
  )
  process.exitCode = 1
}