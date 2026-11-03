/**
 * A limpeza de sessões vencidas grava no banco. Roda sozinha só em produção, para
 * que reiniciar a API durante o desenvolvimento nunca altere dados sem ninguém pedir.
 * Sessões vencidas não dão acesso: deixá-las no banco ocupa espaço, e nada mais.
 */
export function shouldRunSessionCleanup(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = environment.SESSION_CLEANUP_ENABLED?.trim()

  if (configured === 'false') return false
  if (configured === 'true') return true
  return environment.NODE_ENV === 'production'
}
