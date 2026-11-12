/**
 * Ordem alfabética do português para listas exibidas em formulários: ignora acentos e
 * maiúsculas, e compara números pelo valor ("2º andar" antes de "10º andar"). Não depende da
 * configuração de ordenação do banco, que no PostgreSQL padrão põe "Área" depois de "Zona".
 */
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

export function compareNames(a: string, b: string) {
  return collator.compare(a.trim(), b.trim())
}

export function sortByName<T>(rows: readonly T[], nameOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => compareNames(nameOf(a), nameOf(b)))
}
