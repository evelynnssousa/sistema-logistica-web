import { useState } from 'react'
import { checkDuplicates } from '../api/modulesApi'
import type { PossibleDuplicate, RequestModule } from '../api/modulesApi'

/**
 * Confere uma vez antes de enviar. É só um alerta: quem preenche decide, e uma falha na consulta
 * nunca impede o registro.
 */
export function useDuplicateCheck(module: RequestModule) {
  const [duplicates, setDuplicates] = useState<PossibleDuplicate[]>([])
  const [acknowledged, setAcknowledged] = useState(false)

  return {
    duplicates,
    acknowledged,
    /** true: pode enviar. false: há alerta na tela, à espera da decisão. */
    async shouldProceed(body: unknown) {
      if (acknowledged) return true
      try {
        const data = await checkDuplicates(module, body)
        setDuplicates(data.duplicates)
        return data.duplicates.length === 0
      } catch {
        return true
      }
    },
    acknowledge() {
      setAcknowledged(true)
      setDuplicates([])
    },
    dismiss() {
      setDuplicates([])
    },
  }
}

