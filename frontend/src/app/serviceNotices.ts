/**
 * Avisos institucionais dos formulários, com o texto definido pela SLM. Não mude a redação sem
 * decisão da instituição: um teste do backend confere cada texto, e outro confere que os quatro
 * formulários continuam exibindo o aviso antes do botão de envio.
 */
export const serviceNotices = {
  maintenance:
    'O atendimento das solicitações está sujeito à disponibilidade operacional do setor responsável. A data, o horário e as condições solicitadas poderão ser ajustados conforme a disponibilidade e as necessidades do serviço. O envio da solicitação não garante o atendimento nas condições inicialmente solicitadas.',
  fleet:
    'O atendimento das solicitações está sujeito à disponibilidade operacional do setor responsável. A data, o horário e as condições de transporte solicitadas poderão ser ajustados conforme a disponibilidade de veículos, motoristas e as necessidades do serviço. O envio da solicitação não garante o atendimento nas condições inicialmente solicitadas.',
  flights:
    'As solicitações de passagens aéreas estão sujeitas à análise, disponibilidade de voos, condições tarifárias e aprovações necessárias. As opções, datas e horários inicialmente solicitados poderão sofrer alterações durante o processo de cotação e emissão. O envio da solicitação não garante a emissão da passagem nas condições inicialmente pretendidas.',
  warehouse:
    'O fornecimento de materiais está sujeito à disponibilidade de estoque e à avaliação da necessidade apresentada. A quantidade disponibilizada poderá ser diferente da quantidade solicitada, podendo ocorrer atendimento parcial ou não fornecimento de determinados materiais, mesmo quando houver saldo em estoque. A disponibilização observará os critérios de necessidade e a gestão adequada dos materiais.',
} as const

export type ServiceNoticeModule = keyof typeof serviceNotices
