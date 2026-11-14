import { useState } from 'react'
import { createDemoData } from '../app/demoData'
import type { DemoStep } from '../app/demoData'
import { Alert } from './ui/Feedback'
import Icon from './ui/Icon'

/**
 * Dados de demonstração (14/11/2026): solicitações, demandas, atas, materiais e patrimônio fictícios,
 * para ver o sistema em uso. Nunca no banco principal: lá o botão não aparece.
 */
function DemoDataCard({ environment }: { environment: 'local' | 'homologacao' | 'principal' }) {
  const [steps, setSteps] = useState<DemoStep[]>([])
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)

  if (environment === 'principal') return null

  async function run() {
    setRunning(true)
    setFinished(false)
    setSteps([])
    try {
      await createDemoData((step) => setSteps((current) => [...current, step]))
    } catch (error) {
      setSteps((current) => [...current, { label: 'Interrompido', ok: false, detail: error instanceof Error ? error.message : String(error) }])
    } finally {
      setRunning(false)
      setFinished(true)
    }
  }

  const failed = steps.filter((step) => !step.ok)

  return (
    <div className="ui-card ui-stacked">
      <h3>Criar dados de demonstração</h3>
      <p className="management-hint">
        Cria registros fictícios para ver o sistema em uso: 5 solicitações de Manutenção, 5 de Frota, 5 de Passagens aéreas,
        5 pedidos do Almoxarifado, 5 demandas (uma compartilhada com outro setor, uma restrita, várias com etapas), 5 atas e
        contratos, 5 bens do patrimônio, materiais com estoque, veículos e motoristas. Cada um em uma situação diferente
        (aguardando, agendado, em andamento, concluído). Tudo é criado em seu nome. Para apagar depois, use a limpeza
        acima.
      </p>
      <Alert tone="info">Só existe fora do banco principal. Leva cerca de um minuto. Não feche a página enquanto cria.</Alert>
      <button type="button" className="maintenance-primary-button" disabled={running} onClick={() => void run()}>
        <Icon name="add" size={18} /> {running ? 'Criando...' : 'Criar dados de demonstração'}
      </button>
      {steps.length > 0 && (
        <ul className="demo-data-steps" aria-live="polite">
          {steps.map((step, index) => (
            <li key={index} className={step.ok ? 'is-ok' : 'is-failed'}>
              <Icon name={step.ok ? 'success' : 'error'} size={16} /> {step.label}
              {step.detail && <small> — {step.detail}</small>}
            </li>
          ))}
        </ul>
      )}
      {finished && (
        <Alert tone={failed.length ? 'warning' : 'success'}>
          {failed.length
            ? `Pronto, com ${failed.length} ${failed.length === 1 ? 'item que não pôde ser criado' : 'itens que não puderam ser criados'} (veja acima).`
            : 'Pronto! Abra o Dashboard, os módulos e o Controle de Demandas para ver.'}
        </Alert>
      )}
    </div>
  )
}

export default DemoDataCard
