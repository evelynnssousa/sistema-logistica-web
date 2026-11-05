/**
 * Avisos de privacidade dos formulários. Descrevem o que o sistema de fato faz com os dados e
 * são informativos: não pedem aceite. Base legal, prazos de guarda e responsáveis não constam
 * daqui porque dependem de definição institucional (docs/PRIVACIDADE_E_TRATAMENTO_DE_DADOS.md).
 *
 * Ao mudar um texto, atualize a versão aqui e em backend/src/integrations/privacyNotices.ts.
 */

export type PrivacyNoticeContent = {
  version: string | null
  purpose: string
  data: string
  use: string
  protection?: string
}

const communications =
  'Você acompanha o andamento pelo sistema e pode receber avisos por e-mail, que trazem só o protocolo e a situação do pedido.'

export const privacyNotices = {
  maintenance: {
    version: 'manutencao-2026-11',
    purpose: 'Registrar e atender o serviço de manutenção solicitado.',
    data: 'Nome, e-mail e setor da sua conta; andar, sala e local do serviço; a descrição e as observações que você informar.',
    use: `A equipe de atendimento usa esses dados para agendar, executar e concluir o serviço. ${communications}`,
  },
  fleet: {
    version: 'frota-2026-11',
    purpose: 'Organizar e executar o deslocamento solicitado.',
    data: 'Nome, e-mail e setor da sua conta; origem, destino, data e horário; o nome dos passageiros, quando houver. Este formulário não coleta CPF.',
    use: `A equipe de atendimento usa esses dados para agendar e executar o deslocamento e registrar ocorrências. ${communications}`,
  },
  flights: {
    version: 'passagens-2026-11',
    purpose: 'Cotar, aprovar e emitir as passagens solicitadas.',
    data: 'Nome, e-mail e setor da sua conta; andar e sala; trechos, datas, horários e bagagem; nome e CPF de cada passageiro.',
    use: `A equipe de atendimento usa esses dados em cada etapa da solicitação. ${communications}`,
    protection:
      'O CPF é guardado cifrado e aparece mascarado. O número completo só é visível para integrantes autorizados da equipe SLM, e cada consulta fica registrada. O CPF e os nomes dos passageiros não são enviados em e-mails nem em notificações.',
  },
  warehouse: {
    version: 'almoxarifado-2026-11',
    purpose: 'Registrar, atender e entregar o pedido de materiais.',
    data: 'Nome, e-mail e setor da sua conta; materiais, quantidades e a observação que você informar. Na entrega, é registrado o nome de quem recebeu.',
    use: `O Almoxarifado usa esses dados para atender o pedido e registrar a entrega. ${communications}`,
  },
  warehouseExternal: {
    version: null,
    purpose: 'Acompanhar na central do Almoxarifado um pedido feito no sistema governamental.',
    data: 'Número de referência, setor, materiais e quantidades. O nome e o e-mail institucional do solicitante são opcionais: informe-os só se forem necessários para o atendimento.',
    use: 'A equipe do Almoxarifado usa esses dados para atender o pedido. O e-mail serve para comunicar a previsão de entrega e dar a essa pessoa o acompanhamento da entrega, sem outros avisos. Editar este registro não altera o pedido original.',
  },
} satisfies Record<string, PrivacyNoticeContent>
