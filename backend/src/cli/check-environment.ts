import '../loadEnvironment.js'
import { checkEnvironment, hasBlockingProblem } from '../config/environmentCheck.js'

/**
 * npm run config:check
 * Confere as variáveis do backend/.env (ou do ambiente) sem mostrar nenhum valor e sem
 * conectar a banco ou provedor. Sai com 1 se houver erro.
 */
const findings = checkEnvironment()
const label = { ok: 'ok   ', aviso: 'AVISO', erro: 'ERRO ' } as const

console.log(`Ambiente: ${process.env.NODE_ENV === 'production' ? 'produção' : 'desenvolvimento'}`)
for (const finding of findings) {
  console.log(`${label[finding.level]}  ${finding.variable}: ${finding.message}`)
}
if (hasBlockingProblem(findings)) {
  console.log('Há erros: corrija antes de publicar.')
  process.exitCode = 1
} else {
  console.log('Sem erros. Os avisos indicam funções indisponíveis ou incompletas.')
}
