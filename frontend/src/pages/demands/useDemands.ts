import { useOutletContext } from 'react-router-dom'
import type { DemandContext, DemandOptions } from '../../api/demandsApi'

export type DemandsOutlet = { context: DemandContext; options: DemandOptions }

/** Vínculos da pessoa e opções do módulo, carregados uma vez pela página do módulo. */
export function useDemands() {
  return useOutletContext<DemandsOutlet>()
}
