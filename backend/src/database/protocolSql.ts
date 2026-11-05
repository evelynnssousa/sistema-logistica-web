/**
 * Protocolo exibido: o código da migração 007 (MAN-2026-00001) ou, em um banco ainda sem ela,
 * o número anterior. Por to_jsonb, a consulta funciona com ou sem a coluna: aplicar a migração
 * não exige publicar outra versão da API, nem o contrário.
 */
export function protocolSql(alias: string) {
  return `COALESCE(to_jsonb(${alias})->>'protocolo_codigo', ${alias}.protocolo::text)`
}

/** Coluna opcional da migração 007, em texto. Nula em um banco sem ela. */
export function optionalColumnSql(alias: string, column: string) {
  return `to_jsonb(${alias})->>'${column}'`
}
