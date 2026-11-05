import type { AuthenticatedIdentity } from '../auth/roles.js'

/**
 * Matriz de permissões do Controle de Demandas. É a única fonte dessas regras: as rotas decidem por
 * aqui, e a visibilidade em listas, painéis e relatórios usa visibleDemandSql, que precisa dizer o mesmo.
 *
 * Existem somente quatro perfis, e tudo que não está autorizado abaixo é negado:
 * - Servidor do setor (integra o setor): vê as demandas do próprio setor, cadastra para ele e as edita:
 *   informações, prazos, responsáveis e status. A demanda é do setor responsável, do solicitante e dos
 *   colaboradores, e todos eles editam.
 * - Chefe do setor (papel "responsavel" no setor): tudo que o servidor faz, e ainda vê todas as do
 *   próprio setor, inclusive restritas, e acompanha a equipe por relatórios e agenda.
 * - Diretor da DA (papel "diretor" na DA ou permissão demands:directorate): vê, cadastra e edita em
 *   todos os setores, e configura setores, integrantes e categorias. Definir diretores segue com o
 *   administrador.
 * - Administrador do sistema (perfil da conta): consulta tudo e não altera nada.
 *
 * Acúmulo: valem os poderes somados, exceto que o administrador sem o perfil de Diretor fica somente
 * com a consulta, mesmo que também integre ou chefie um setor.
 *
 * Demanda restrita: dentro do setor, o servidor só a vê se estiver nominalmente envolvido. Chefe,
 * Diretor e Administrador veem todas. Envolvimento nominal nunca abre demanda de outro setor.
 * Rascunho: é trabalho ainda não cadastrado, visto e alterado só por quem o criou.
 */

export const directorateRoles = ['diretor'] as const
export type DirectorateRole = (typeof directorateRoles)[number]

export type DemandProfile = 'servidor' | 'chefe' | 'diretor' | 'administrador'

export type DemandMembership = {
  sectorId: string
  sectorName: string
  role: 'colaborador' | 'responsavel'
  /** Setor desativado continua consultável por quem o integra, mas não recebe novas demandas. */
  sectorActive?: boolean
}

export type DemandContext = {
  userId: string
  administrator: boolean
  /** Diretor: permissão demands:directorate ou papel "diretor". */
  directorate: boolean
  memberships: readonly DemandMembership[]
}

export type DemandFacts = {
  createdBy: string
  requesterId: string | null
  responsibleId: string | null
  followUpManagerId?: string | null
  draft: boolean
  restricted: boolean
  originSectorId: string | null
  responsibleSectorId: string | null
  collaboratorSectorIds: readonly string[]
  /** Colaboradores, autorizados e quem acompanha. */
  participantIds: readonly string[]
  subtaskAssigneeIds: readonly string[]
}

export function hasDemandAccess(context: DemandContext) {
  return context.administrator || context.directorate || context.memberships.length > 0
}

/** Administrador sem o perfil de Diretor: somente consulta, mesmo que integre ou chefie um setor. */
export function isConsultationOnly(context: DemandContext) {
  return context.administrator && !context.directorate
}

/** Os perfis da pessoa, para a tela informar com qual acesso ela está. */
export function demandProfiles(context: DemandContext): DemandProfile[] {
  const profiles: DemandProfile[] = []
  if (context.administrator) profiles.push('administrador')
  if (context.directorate) profiles.push('diretor')
  if (ledSectorIds(context).length > 0) profiles.push('chefe')
  if (context.memberships.some((item) => item.role === 'colaborador')) profiles.push('servidor')
  return profiles
}

export function ledSectorIds(context: DemandContext) {
  return context.memberships.filter((item) => item.role === 'responsavel').map((item) => item.sectorId)
}

/** Painéis e relatórios gerenciais. */
export function canSeeReports(context: DemandContext) {
  return context.administrator || context.directorate || ledSectorIds(context).length > 0
}

/**
 * Até onde a pessoa enxerga, além do próprio setor. Vai para o SQL como parâmetro:
 * 0 = só o que os setores dela alcançam; 1 = todas as demandas publicadas.
 */
export function visibilityLevel(context: DemandContext) {
  return context.administrator || context.directorate ? 1 : 0
}

/** Para quais setores a pessoa pode cadastrar demandas. */
export function creationScope(context: DemandContext) {
  if (isConsultationOnly(context)) return { anywhere: false, sectorIds: [] as string[] }
  return {
    anywhere: context.directorate,
    sectorIds: [...new Set(context.memberships.filter((item) => item.sectorActive !== false).map((item) => item.sectorId))],
  }
}

export function canCreateDemands(context: DemandContext) {
  const scope = creationScope(context)
  return scope.anywhere || scope.sectorIds.length > 0
}

/** Compromissos da agenda: só quem gerencia demandas, ou seja, Chefe e Diretor. */
export function canCreateAgendaEvents(context: DemandContext) {
  return !isConsultationOnly(context) && (context.directorate || ledSectorIds(context).length > 0)
}

/** Setores, integrantes e categorias do módulo. Quem define diretores continua sendo o administrador. */
export function canConfigureModule(context: DemandContext, permissions: readonly string[]) {
  return context.directorate || permissions.includes('demands:configure')
}

export function resolveDemandAccess(context: DemandContext, demand: DemandFacts) {
  const { userId } = context
  const creator = demand.createdBy === userId
  const involved =
    creator ||
    demand.responsibleId === userId ||
    demand.requesterId === userId ||
    demand.followUpManagerId === userId ||
    demand.participantIds.includes(userId) ||
    demand.subtaskAssigneeIds.includes(userId)

  const demandSectors = new Set(
    [demand.originSectorId, demand.responsibleSectorId, ...demand.collaboratorSectorIds].filter(Boolean),
  )
  const sectorLinks = context.memberships.filter((item) => demandSectors.has(item.sectorId))
  const leadsDemandSector = sectorLinks.some((item) => item.role === 'responsavel')

  const readThroughSectorOrDirectorate =
    context.directorate || leadsDemandSector || (sectorLinks.length > 0 && (!demand.restricted || involved))
  const read = demand.draft ? creator : context.administrator || readThroughSectorOrDirectorate

  // Quem vê uma demanda a vê por criá-la, por ser Diretor ou por integrar um dos setores dela. Só o
  // administrador vê sem poder alterar.
  const edit = read && !isConsultationOnly(context)

  return {
    read,
    /** Dados, prazos, status, colaboração e recorrência. */
    edit,
    /** Distribuir e reatribuir. */
    assign: edit,
    /** Mudar o setor de uma demanda cadastrada a leva para outro setor: só o Diretor. */
    transfer: edit && (demand.draft || context.directorate),
    comment: edit,
    attach: edit,
    subtasksManage: edit,
    /** Receber avisos da demanda não altera o registro; o administrador só consulta. */
    follow: read && !isConsultationOnly(context),
    /** Sem edição, a tela apresenta a demanda em modo de consulta. */
    readOnly: read && !edit,
    /** A leitura só existe por ser administrador do sistema, e por isso é auditada. */
    administrativeRead: read && demand.restricted && !demand.draft && !readThroughSectorOrDirectorate,
  }
}

export type DemandAccess = ReturnType<typeof resolveDemandAccess>

export type DemandContextData = {
  memberships: readonly DemandMembership[]
  directorateRole: string | null
}

export function contextFromIdentity(identity: AuthenticatedIdentity, data: DemandContextData): DemandContext {
  return {
    userId: identity.userId,
    administrator: identity.role === 'administrator',
    directorate: data.directorateRole === 'diretor' || identity.permissions.includes('demands:directorate'),
    memberships: data.memberships,
  }
}

/**
 * Filtro de visibilidade em SQL, para nada restrito chegar a uma contagem ou lista.
 * "alias" é o alias de public.demands; os parâmetros são as posições do usuário e do nível.
 */
export function visibleDemandSql(alias: string, userParam: string, levelParam: string) {
  const involved = `(
    ${alias}.criado_por = ${userParam}
    OR ${alias}.solicitante_id = ${userParam}
    OR ${alias}.responsavel_id = ${userParam}
    OR ${alias}.gestor_acompanhamento_id = ${userParam}
    OR EXISTS (SELECT 1 FROM public.demand_participants vp
                WHERE vp.demand_id = ${alias}.id AND vp.user_id = ${userParam})
    OR EXISTS (SELECT 1 FROM public.demand_subtasks vs
                WHERE vs.demand_id = ${alias}.id AND vs.responsavel_id = ${userParam})
  )`
  const sectorMember = (condition: string) => `EXISTS (
    SELECT 1 FROM public.demand_sector_members vm
     WHERE vm.user_id = ${userParam} AND vm.ativo AND ${condition}
       AND (vm.sector_id = ${alias}.setor_responsavel_id
            OR vm.sector_id = ${alias}.setor_origem_id
            OR EXISTS (SELECT 1 FROM public.demand_sector_links vl
                        WHERE vl.demand_id = ${alias}.id AND vl.sector_id = vm.sector_id))
  )`
  return `(${alias}.excluida_em IS NULL AND (
    (${alias}.rascunho AND ${alias}.criado_por = ${userParam})
    OR (NOT ${alias}.rascunho AND (
      ${levelParam}::int >= 1
      OR ${sectorMember(`vm.papel = 'responsavel'`)}
      OR (${sectorMember('true')} AND (NOT ${alias}.restrita OR ${involved}))
    ))
  ))`
}
