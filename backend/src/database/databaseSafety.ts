/**
 * Barreiras para que testes nunca alcancem o banco real. Este arquivo não tem
 * dependências porque é carregado antes de qualquer outro, inclusive do .env.
 */

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackHost(hostname: string) {
  return loopbackHosts.has(hostname)
}

/** Detecta execução de teste, mesmo quando alguém chama um arquivo diretamente. */
export function isTestRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    environment.NODE_ENV === 'test' ||
    Boolean(environment.NODE_TEST_CONTEXT) ||
    /\.test\.[cm]?[jt]s$/.test(argv[1] ?? '')
  )
}

function isDisposableDatabase(connectionString: string) {
  try {
    const { hostname, pathname } = new URL(connectionString)
    return isLoopbackHost(hostname) && pathname.endsWith('_test')
  } catch {
    return false
  }
}

const refusedMessage =
  'Recusado: o banco de teste precisa ser local e ter nome terminado em _test.'

/** Endereço do banco descartável dos testes de integração, que apagam o schema public. */
export function requireDisposableDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const url = environment.TEST_DATABASE_URL?.trim()
  if (!url) throw new Error('Defina TEST_DATABASE_URL.')
  if (!isDisposableDatabase(url)) throw new Error(refusedMessage)
  return url
}

/** Em teste, nenhuma conexão comum pode ser aberta com um banco que não seja descartável. */
export function assertDatabaseAllowedForRuntime(
  connectionString: string,
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
) {
  if (isTestRuntime(environment, argv) && !isDisposableDatabase(connectionString)) {
    throw new Error(refusedMessage)
  }
}
