import { useEffect, useState } from 'react'
import { getManagedFormContent } from '../api/configApi'
import type { FormContent, ManagedField } from '../api/configApi'

/**
 * Formulário de leiaute fixo editado no Gerenciador de formulários (13/11/2026): nomes dos campos
 * existentes e campos novos. Sem resposta, vale o que a tela já mostra.
 */
const cache = new Map<string, Promise<FormContent | null>>()

function load(key: string) {
  if (!cache.has(key)) {
    cache.set(
      key,
      getManagedFormContent(key)
        .then((result) => result.content)
        .catch(() => {
          cache.delete(key)
          return null
        }),
    )
  }
  return cache.get(key)!
}

export function useManagedForm(key: string) {
  const [content, setContent] = useState<FormContent | null>(null)
  useEffect(() => {
    let active = true
    void load(key).then((result) => {
      if (active) setContent(result)
    })
    return () => {
      active = false
    }
  }, [key])

  const label = (id: string, fallback: string) => content?.fields.find((field) => field.id === id)?.label || fallback
  const extraFields: ManagedField[] = (content?.fields ?? []).filter((field) => field.id.startsWith('custom-') && field.active)
  return { content, label, extraFields }
}

/** Depois de publicar um formulário, as telas abertas passam a usar a versão nova. */
export function forgetManagedForm(key: string) {
  cache.delete(key)
}
