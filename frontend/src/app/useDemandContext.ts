import { useEffect, useState } from 'react'
import { fetchDemandContext } from '../api/demandsApi'
import type { DemandContext } from '../api/demandsApi'
import { accessRefusedEvent } from '../auth/apiClient'

/** Avisa o menu de que os setores mudaram, sem esperar a próxima entrada no sistema. */
export const demandContextChangedEvent = 'slm:demand-context-changed'

const refusalReloadIntervalMs = 5_000
let lastLoadAt = 0

/**
 * Vínculos da pessoa com o Controle de Demandas. Só decide o que a tela mostra: quem protege os
 * dados é o backend, em cada requisição. Sem resposta, o módulo fica oculto.
 */
export function useDemandContext() {
  const [context, setContext] = useState<DemandContext | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const load = () => {
      lastLoadAt = Date.now()
      fetchDemandContext()
        .then((data) => {
          if (active) {
            setContext(data)
            setFailed(false)
          }
        })
        .catch(() => {
          if (active) setFailed(true)
        })
    }
    // A própria recusa dispara o evento, e o menu e a página têm cada um a sua cópia deste gancho:
    // sem o intervalo, um 401 faria as duas se chamarem sem parar.
    const reloadAfterRefusal = () => {
      if (Date.now() - lastLoadAt >= refusalReloadIntervalMs) load()
    }
    load()
    window.addEventListener(accessRefusedEvent, reloadAfterRefusal)
    window.addEventListener(demandContextChangedEvent, load)
    return () => {
      active = false
      window.removeEventListener(accessRefusedEvent, reloadAfterRefusal)
      window.removeEventListener(demandContextChangedEvent, load)
    }
  }, [])

  return { context, failed }
}
