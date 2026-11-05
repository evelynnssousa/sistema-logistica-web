/**
 * Versão vigente do aviso de privacidade de cada formulário. A versão exibida fica no histórico
 * da solicitação, para saber qual texto a pessoa viu. O texto está na tela, em
 * frontend/src/app/privacyNotices.ts: ao mudá-lo, atualize a versão nos dois lugares.
 */
export const privacyNoticeVersions = {
  maintenance: 'manutencao-2026-11',
  fleet: 'frota-2026-11',
  flights: 'passagens-2026-11',
  warehouse: 'almoxarifado-2026-11',
} as const
