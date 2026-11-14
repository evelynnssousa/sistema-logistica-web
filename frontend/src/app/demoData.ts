import { apiRequest } from '../auth/apiClient'
import type { ApiResponse } from '../auth/apiClient'

/**
 * Dados de demonstração (14/11/2026), para ver o sistema "como se estivesse funcionando". Só a
 * homologação e o ambiente local: a tela não oferece o botão no banco principal.
 *
 * Tudo é criado pelas mesmas rotas que as telas usam, com a sessão de quem clicou: as regras, os
 * protocolos, o histórico e as permissões valem como num uso real. Demandas e atas são a exceção:
 * o Administrador só consulta o Controle de Demandas, então elas passam por /admin/test-data/demo,
 * que cria como a Diretoria, com as mesmas validações. Nomes, CPFs e e-mails são
 * fictícios. Para apagar depois: Configurações → Dados de teste → Limpar.
 */

export type DemoStep = { label: string; ok: boolean; detail?: string }

const send = <T = object>(path: string, method: string, body?: unknown) =>
  apiRequest<ApiResponse & T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const get = <T = object>(path: string) => apiRequest<ApiResponse & T>(path)

/** Data e hora daqui a "days" dias, às "hour" horas de Brasília, em ISO. */
function at(days: number, hour = 10, minute = 0) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  date.setUTCHours(hour + 3, minute, 0, 0)
  return date.toISOString()
}
const day = (days: number) => at(days).slice(0, 10)

/** CPF fictício com dígitos verificadores válidos. */
function fakeCpf(seed: number) {
  const base = String(100000000 + seed * 7919).slice(0, 9).split('').map(Number)
  const digit = (numbers: number[]) => {
    const sum = numbers.reduce((total, value, index) => total + value * (numbers.length + 1 - index), 0)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  const first = digit(base)
  const second = digit([...base, first])
  return [...base, first, second].join('')
}

type FormField = {
  id: string
  label: string
  type: string
  required: boolean
  active: boolean
  options: string[]
  catalog: string | null
  minLength: number | null
  min: number | null
  validation: string
  visibleTo: 'all' | 'staff'
  visibleWhen: { field: string; equals: string } | null
}

// Campos padrão que o Gerenciador de formulários pode tornar obrigatórios, e o nome de cada um no envio.
const standardKeys: Record<string, Record<string, string>> = {
  maintenance: { sala: 'sala', dataPreferencial: 'dataPreferencial', observacoes: 'observacoes' },
  fleet: { floor: 'andarId', returnAt: 'dataHoraRetorno', vehicle: 'veiculo', passengerNames: 'passageiros', notes: 'observacoes' },
  airTravel: { requesterRoom: 'sala', baggage: 'bagagem', notes: 'observacoes' },
}

/** Um valor de exemplo que passa nas regras do campo. */
function sampleValue(field: FormField, catalogs: Record<string, { id: string; active: boolean }[]>) {
  if (field.catalog) return catalogs[field.catalog]?.find((item) => item.active)?.id ?? ''
  if (field.options.length > 0) return field.options[0]
  const pad = (text: string) => (field.minLength && text.length < field.minLength ? text.padEnd(field.minLength, '.') : text)
  switch (field.type) {
    case 'number': return String(Math.max(field.min ?? 1, 1))
    case 'email': return 'demonstracao@jucesp.sp.gov.br'
    case 'phone': return '(11) 3468-3000'
    case 'date': return day(1)
    case 'time': return '10:00'
    case 'dateTime': return at(1, 10).slice(0, 16)
    case 'boolean':
    case 'checkbox': return 'true'
    case 'attachment': return 'documento-demonstracao.pdf'
  }
  if (field.validation === 'digits') return pad('12345')
  if (field.validation === 'phone') return '(11) 3468-3000'
  if (field.validation === 'email') return 'demonstracao@jucesp.sp.gov.br'
  return pad('Informação de demonstração')
}

export async function createDemoData(onStep: (step: DemoStep) => void) {
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await run()
      onStep({ label, ok: true })
      return result
    } catch (error) {
      onStep({ label, ok: false, detail: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Listas de apoio: andares, tipos de serviço, setores, unidades e categorias de material.
  // -------------------------------------------------------------------------
  type Option = { id: string; label: string; active: boolean }
  const catalog = (await get<{ catalog: Record<string, Option[]> }>('/settings/catalog')).catalog
  async function option(category: string, label: string, acronym?: string) {
    // Só uma opção ativa serve: setor ou andar desativado é recusado no cadastro.
    const same = catalog[category]?.filter((item) => item.label.toLowerCase().startsWith(label.toLowerCase())) ?? []
    const found = same.find((item) => item.active)
    if (found) return found.id
    if (same.length > 0) {
      label = `${label} (demonstração)`
      acronym = undefined
    }
    const again = catalog[category]?.find((item) => item.label.toLowerCase() === label.toLowerCase() && item.active)
    if (again) return again.id
    const created = await send<{ option: Option }>(`/settings/catalog/${category}`, 'POST', { label, acronym })
    catalog[category] = [...(catalog[category] ?? []), created.option]
    return created.option.id
  }
  // Formulários editados no Gerenciador: campos obrigatórios a mais recebem um valor de exemplo.
  const forms = new Map<string, FormField[]>()
  async function formOf(key: string) {
    if (!forms.has(key)) {
      const content = await get<{ content?: { fields?: FormField[] } }>(`/forms/managed/${key}`).catch(() => null)
      forms.set(key, content?.content?.fields ?? [])
    }
    return forms.get(key)!
  }
  /** Completa o corpo do envio com o que o formulário publicado exige. */
  async function fill<T extends Record<string, unknown>>(key: string, body: T, defaults: Record<string, unknown> = {}): Promise<T> {
    const fields = await formOf(key)
    const filled: Record<string, unknown> = { ...body }
    const custom: Record<string, string> = { ...((body.customFields as Record<string, string> | undefined) ?? {}) }
    for (const field of fields) {
      if (!field.active || !field.required || field.visibleTo === 'staff' || field.visibleWhen) continue
      if (field.id.startsWith('custom-')) {
        if (!custom[field.id]) custom[field.id] = sampleValue(field, catalog)
        continue
      }
      const bodyKey = standardKeys[key]?.[field.id]
      if (!bodyKey) continue
      const current = filled[bodyKey]
      if (current === undefined || current === null || current === '' || (Array.isArray(current) && current.length === 0)) {
        filled[bodyKey] = defaults[bodyKey] ?? 'Informação de demonstração'
      }
    }
    return { ...filled, customFields: custom } as unknown as T
  }

  const floors = await step('Listas: andares', async () => ({
    terreo: await option('floors', 'Térreo'),
    primeiro: await option('floors', '1º andar'),
    segundo: await option('floors', '2º andar'),
  }))
  const services = await step('Listas: tipos de serviço', async () => ({
    eletrica: await option('serviceTypes', 'Elétrica'),
    hidraulica: await option('serviceTypes', 'Hidráulica'),
    ar: await option('serviceTypes', 'Ar-condicionado'),
    marcenaria: await option('serviceTypes', 'Marcenaria'),
  }))
  const sectors = await step('Listas: setores', async () => ({
    protocolo: await option('sectors', 'Protocolo', 'PROT'),
    ti: await option('sectors', 'Tecnologia da Informação', 'TI'),
    gabinete: await option('sectors', 'Gabinete da Presidência', 'GAB'),
    juridico: await option('sectors', 'Procuradoria Jurídica', 'PJ'),
  }))
  const units = await step('Listas: unidades', async () => ({
    unidade: await option('measurementUnits', 'Unidade', 'UN'),
    resma: await option('measurementUnits', 'Resma', 'RM'),
    caixa: await option('measurementUnits', 'Caixa', 'CX'),
  }))
  const materialCategories = await step('Listas: categorias de material', async () => ({
    expediente: await option('warehouseCategories', 'Material de expediente'),
    limpeza: await option('warehouseCategories', 'Material de limpeza'),
    informatica: await option('warehouseCategories', 'Informática'),
  }))

  // -------------------------------------------------------------------------
  // Manutenção: 5 solicitações em situações diferentes.
  // -------------------------------------------------------------------------
  const maintenance = [
    { local: 'Sala 12 (Protocolo)', tipo: 'ar', andar: 'primeiro', descricao: 'Ar-condicionado pingando água sobre a mesa de atendimento.', fluxo: 'concluir' },
    { local: 'Copa do 2º andar', tipo: 'hidraulica', andar: 'segundo', descricao: 'Torneira da pia com vazamento constante.', fluxo: 'andamento' },
    { local: 'Recepção', tipo: 'eletrica', andar: 'terreo', descricao: 'Três lâmpadas queimadas no corredor de entrada.', fluxo: 'agendar' },
    { local: 'Sala de reuniões do Gabinete', tipo: 'marcenaria', andar: 'segundo', descricao: 'Porta do armário com a dobradiça solta.', fluxo: 'aguardar' },
    { local: 'Sala 7 (Jurídico)', tipo: 'eletrica', andar: 'primeiro', descricao: 'Tomada da estação 3 sem energia.', fluxo: 'reagendar' },
  ] as const
  for (const [index, item] of maintenance.entries()) {
    await step(`Manutenção ${index + 1}: ${item.local}`, async () => {
      const created = await send<{ id: string }>('/maintenance/requests', 'POST', await fill('maintenance', {
        andarId: floors?.[item.andar],
        tipoServicoId: services?.[item.tipo],
        localServico: item.local,
        sala: item.local,
        descricao: item.descricao,
        dataPreferencial: at(index + 2, 9),
        prioridade: index === 0 ? 'alta' : 'normal',
      }, { observacoes: 'Pedido de demonstração.' }))
      const path = `/maintenance/requests/${created.id}`
      if (item.fluxo === 'aguardar') return
      await send(`${path}/schedule`, 'POST', { dataAgendada: at(index - 2, 9), dataFim: at(index - 2, 11), motivoCodigo: 'outro', comentario: 'Melhor horário disponível da equipe.', confirmarConflito: true })
      if (item.fluxo === 'reagendar') {
        await send(`${path}/schedule`, 'POST', { dataAgendada: at(index + 3, 14), comentario: 'Equipe de elétrica em outro chamado.', motivoCodigo: 'outro', confirmarConflito: true })
        return
      }
      if (item.fluxo === 'agendar') return
      await send(`${path}/start`, 'POST', { comentario: 'Equipe no local.' })
      if (item.fluxo === 'concluir') await send(`${path}/complete`, 'POST', { comentario: 'Dreno desentupido e bandeja limpa. Testado por 30 minutos.' })
    })
  }

  // -------------------------------------------------------------------------
  // Frota: veículos, motoristas e 5 pedidos de viagem.
  // -------------------------------------------------------------------------
  const vehicles = await step('Frota: veículos', async () => {
    const existing = await get<{ vehicles: { id: string; plate?: string; placa?: string }[] }>('/fleet/vehicles')
    const plates = new Set(existing.vehicles.map((vehicle) => (vehicle.plate ?? vehicle.placa ?? '').toUpperCase()))
    const list = [
      { placa: 'FJC-2A31', modelo: 'Chevrolet Spin', identificacao: 'Spin prata', kmAtual: 48210 },
      { placa: 'EKT-7B45', modelo: 'Volkswagen Gol', identificacao: 'Gol branco', kmAtual: 91530 },
    ]
    for (const vehicle of list) {
      if (!plates.has(vehicle.placa)) await send('/fleet/vehicles', 'POST', await fill('vehicle', vehicle))
    }
  })
  const drivers = await step('Frota: motoristas', async () => {
    const existing = await get<{ drivers: { id: string; name: string }[] }>('/fleet/drivers')
    const ids: string[] = []
    for (const [name, registration] of [['Carlos Pereira (demonstração)', '1001'], ['Márcia Lima (demonstração)', '1002']]) {
      const found = existing.drivers.find((driver) => driver.name === name)
      ids.push(found ? found.id : (await send<{ id: string }>('/fleet/drivers', 'POST', await fill('driver', { name, registration, active: true, userId: null }))).id)
    }
    return ids
  })
  void vehicles
  const trips = [
    { origem: 'Sede da JUCESP', destino: 'Fórum João Mendes', finalidade: 'Entrega de processos ao cartório.', fluxo: 'concluir', veiculo: 'Spin prata FJC-2A31' },
    { origem: 'Sede da JUCESP', destino: 'Secretaria da Fazenda', finalidade: 'Reunião sobre o convênio de dados.', fluxo: 'andamento', veiculo: 'Gol branco EKT-7B45' },
    { origem: 'Sede da JUCESP', destino: 'Escritório regional de Campinas', finalidade: 'Levar equipamentos de informática.', fluxo: 'agendar', veiculo: 'Spin prata FJC-2A31' },
    { origem: 'Sede da JUCESP', destino: 'Aeroporto de Congonhas', finalidade: 'Levar o presidente para viagem a Brasília.', fluxo: 'aguardar', veiculo: '' },
    { origem: 'Sede da JUCESP', destino: 'Correios (agência central)', finalidade: 'Postagem de notificações.', fluxo: 'cancelar', veiculo: '' },
  ] as const
  for (const [index, trip] of trips.entries()) {
    await step(`Frota ${index + 1}: ${trip.destino}`, async () => {
      const created = await send<{ id: string }>('/fleet/requests', 'POST', await fill('fleet', {
        origem: trip.origem,
        destino: trip.destino,
        dataHora: at(index - 1, 9 + index),
        dataHoraRetorno: at(index - 1, 12 + index),
        finalidade: trip.finalidade,
        passageiros: [{ nome: index % 2 ? 'Ana Souza (fictícia)' : 'Bruno Alves (fictício)' }],
        ...(trip.veiculo ? { veiculo: trip.veiculo } : {}),
      }, { andarId: floors?.terreo, veiculo: 'Spin prata FJC-2A31', observacoes: 'Pedido de demonstração.' }))
      const path = `/fleet/requests/${created.id}`
      if (trip.fluxo === 'aguardar') return
      if (trip.fluxo === 'cancelar') {
        await send(`${path}/cancel`, 'POST', { motivoCodigo: 'outro', motivo: 'A reunião foi transformada em videoconferência.' })
        return
      }
      await send(`${path}/schedule`, 'POST', { dataAgendada: at(index - 1, 9 + index), dataFim: at(index - 1, 12 + index), motivoCodigo: 'outro', comentario: 'Horário confirmado com o solicitante.', confirmarConflito: true })
      if (drivers?.[index % 2]) await send(`${path}/driver`, 'POST', { driverId: drivers[index % 2], notes: 'Retirar a chave na portaria.' }).catch(() => undefined)
      if (trip.fluxo === 'agendar') return
      await send(`${path}/start`, 'POST', { comentario: 'Saída registrada pela equipe.' })
      if (trip.fluxo === 'concluir') await send(`${path}/complete`, 'POST', { comentario: 'Documentos entregues. Retorno sem ocorrências.' })
    })
  }

  // -------------------------------------------------------------------------
  // Passagens aéreas: 5 pedidos, com passageiros e CPFs fictícios.
  // -------------------------------------------------------------------------
  const flights = [
    { ida: ['GRU', 'BSB'], tipo: 'ida_volta', nome: 'Helena Martins (fictícia)', motivo: 'Reunião no Departamento Nacional de Registro Empresarial.', ate: 'aguardando_aprovacao' },
    { ida: ['CGH', 'SDU'], tipo: 'ida_volta', nome: 'Rafael Costa (fictício)', motivo: 'Encontro das Juntas Comerciais do Sudeste.', ate: 'em_emissao' },
    { ida: ['VCP', 'CNF'], tipo: 'somente_ida', nome: 'Juliana Rocha (fictícia)', motivo: 'Curso de capacitação em registro digital.', ate: 'em_cotacao' },
    { ida: ['GRU', 'POA'], tipo: 'ida_volta', nome: 'Marcos Teixeira (fictício)', motivo: 'Visita técnica ao sistema de registro do RS.', ate: 'aguardando_aprovacao' },
    { ida: ['CGH', 'BSB'], tipo: 'ida_volta', nome: 'Patrícia Gomes (fictícia)', motivo: 'Audiência no Ministério do Desenvolvimento.', ate: 'em_cotacao' },
  ] as const
  for (const [index, flight] of flights.entries()) {
    await step(`Passagem ${index + 1}: ${flight.ida[0]} → ${flight.ida[1]}`, async () => {
      const out = day(index * 4 + 10)
      const back = day(index * 4 + 12)
      const created = await send<{ id: string }>('/flights/requests', 'POST', await fill('airTravel', {
        andarId: floors?.segundo,
        tipoViagem: flight.tipo,
        ida: { origem: flight.ida[0], destino: flight.ida[1], data: out, horario: '08:00' },
        ...(flight.tipo === 'ida_volta' ? { volta: { origem: flight.ida[1], destino: flight.ida[0], data: back, horario: '18:00' } } : {}),
        bagagem: index % 2 ? 'Bagagem despachada (23 kg)' : 'Bagagem de mão',
        motivo: flight.motivo,
        observacoes: flight.motivo,
        passageiros: [{ nome: flight.nome, cpf: fakeCpf(index + 1), dataNascimento: `198${index}-0${index + 1}-15` }],
      }, { sala: 'Sala 20', observacoes: 'Pedido de demonstração.' }))
      const path = `/flights/requests/${created.id}`
      if (flight.ate === 'em_cotacao') return
      await send(`${path}/advance`, 'POST', { status: 'aguardando_aprovacao', comentario: 'Cotação enviada para aprovação.' })
      if (flight.ate === 'em_emissao') await send(`${path}/advance`, 'POST', { status: 'em_emissao', comentario: 'Aprovada pela chefia.' })
    })
  }

  // -------------------------------------------------------------------------
  // Almoxarifado: materiais, entradas no estoque e 5 pedidos.
  // -------------------------------------------------------------------------
  const materials = await step('Almoxarifado: materiais', async () => {
    const existing = await get<{ materials: { id: string; code: string }[] }>('/warehouse/materials?inactive=true')
    const list = [
      { code: 'DEMO-001', name: 'Papel sulfite A4 75 g', unit: 'resma', category: 'expediente', quantity: 120 },
      { code: 'DEMO-002', name: 'Caneta esferográfica azul', unit: 'caixa', category: 'expediente', quantity: 40 },
      { code: 'DEMO-003', name: 'Grampeador de mesa', unit: 'unidade', category: 'expediente', quantity: 15 },
      { code: 'DEMO-004', name: 'Detergente neutro 500 ml', unit: 'unidade', category: 'limpeza', quantity: 60 },
      { code: 'DEMO-005', name: 'Mouse óptico USB', unit: 'unidade', category: 'informatica', quantity: 25 },
      { code: 'DEMO-006', name: 'Pasta suspensa', unit: 'caixa', category: 'expediente', quantity: 30 },
    ] as const
    const ids: string[] = []
    for (const item of list) {
      const found = existing.materials.find((material) => material.code === item.code)
      const id =
        found?.id ??
        (
          await send<{ id: string }>('/warehouse/materials', 'POST', await fill('material', {
            code: item.code,
            name: item.name,
            description: `${item.name} (cadastro de demonstração).`,
            unitId: units?.[item.unit],
            categoryId: materialCategories?.[item.category],
            active: true,
            location: 'Almoxarifado central, prateleira A',
          }))
        ).id
      ids.push(id)
      if (!found) {
        await send('/warehouse/stock-movements', 'POST', {
          materialId: id,
          tipo: 'entrada',
          quantidade: item.quantity,
          justificativa: 'Estoque inicial de demonstração.',
          valorPago: String(item.quantity * 12.5),
          notaFiscal: `NF ${1000 + ids.length}`,
          fornecedor: 'Papelaria Exemplo Ltda. (fictícia)',
        })
      }
    }
    return ids
  })
  const reasons = await get<{ reasons?: { warehouse?: { key: string; active?: boolean }[] } }>('/operations/capabilities').catch(() => null)
  const partialReason = reasons?.reasons?.warehouse?.find((reason) => reason.active !== false && reason.key !== 'outro')?.key
  const warehouseFlow = ['entregar', 'atender', 'analisar', 'pendente', 'parcial'] as const
  for (const [index, flow] of warehouseFlow.entries()) {
    await step(`Almoxarifado ${index + 1}: pedido de materiais`, async () => {
      if (!materials) throw new Error('Sem materiais cadastrados.')
      const items = [
        { materialId: materials[index % materials.length], requested: 2 + index },
        { materialId: materials[(index + 1) % materials.length], requested: 1 + (index % 3) },
      ]
      const created = await send<{ id: string }>('/warehouse/requests', 'POST', await fill('warehouseRequest', {
        note: ['Reposição mensal do setor.', 'Material para o mutirão de atendimento.', 'Pedido para a nova estação de trabalho.', 'Itens de limpeza da copa.', 'Material para o curso interno.'][index],
        items,
      }))
      const path = `/warehouse/requests/${created.id}`
      if (flow === 'pendente') return
      await send(`${path}/status`, 'POST', { status: 'em_analise', comment: 'Conferindo a disponibilidade.' })
      if (flow === 'analisar') return
      if (flow === 'parcial') {
        await send(`${path}/items`, 'PUT', { items: [{ ...items[0], fulfilled: 1, ...(partialReason ? { reasonCode: partialReason } : {}), note: 'Restante na próxima compra.' }, { ...items[1], fulfilled: items[1].requested }] })
        await send(`${path}/status`, 'POST', { status: 'atendido_parcial', comment: 'Parte dos itens separada.' })
        return
      }
      await send(`${path}/items`, 'PUT', { items: items.map((item) => ({ ...item, fulfilled: item.requested })) })
      await send(`${path}/status`, 'POST', { status: 'atendido', comment: 'Itens separados para retirada.' })
      if (flow === 'entregar') {
        await send(`${path}/deliver`, 'POST', await fill('warehouseDelivery', { receivedBy: 'Fernanda Dias (fictícia)', comment: 'Entregue no setor.', deliveredDate: day(0), deliveryNote: 'Conferido na entrega.' }))
      }
    })
  }

  // -------------------------------------------------------------------------
  // Controle de Demandas: setores, 5 demandas (uma compartilhada, uma restrita) e etapas.
  // -------------------------------------------------------------------------
  const me = await get<{ user: { id: string } }>('/auth/me')
  const demandSectors = await step('Demandas: setores', async () => {
    const existing = await get<{ sectors: { id: string; name: string }[] }>('/demands/settings/sectors')
    const ensure = async (name: string, acronym: string, isSlm = false) => {
      const found = existing.sectors.find((sector) => sector.name === name)
      const id = found?.id ?? (await send<{ id: string }>('/demands/settings/sectors', 'POST', { name, acronym, isSlm })).id
      await send(`/demands/settings/sectors/${id}/members/${me.user.id}`, 'PUT', { role: 'responsavel', canCreate: true, seesSector: true, chefia: true })
      return id
    }
    return { slm: await ensure('SLM (demonstração)', 'SLM', true), compras: await ensure('Compras (demonstração)', 'COMP') }
  })
  const demandOptions = await step('Demandas: categorias', async () => get<{ categories: { id: string; name: string }[] }>('/demands/options'))
  const category = (index: number) => demandOptions?.categories[index % Math.max(1, demandOptions.categories.length)]?.id ?? null
  const demands = [
    { title: 'Renovar o contrato de manutenção dos elevadores', description: 'O contrato atual vence em 60 dias. Levantar orçamentos e preparar o termo aditivo.', priority: 'alta', due: 20, shared: false, restricted: false, steps: ['Pedir três orçamentos', 'Comparar propostas', 'Enviar para a Procuradoria'] },
    { title: 'Compra de cadeiras para a nova sala de atendimento', description: 'Comprar 20 cadeiras ergonômicas para a sala do térreo. Demanda compartilhada com Compras.', priority: 'media', due: 35, shared: true, restricted: false, steps: ['Definir especificação', 'Abrir processo de compra'] },
    { title: 'Apuração de avaria no veículo FJC-2A31', description: 'Registro interno sobre a avaria no para-choque. Acesso restrito à chefia.', priority: 'alta', due: 7, shared: false, restricted: true, steps: ['Colher relato do motorista', 'Orçar o conserto'] },
    { title: 'Inventário anual do almoxarifado', description: 'Conferência física de todos os itens do almoxarifado central.', priority: 'media', due: 45, shared: false, restricted: false, steps: [] },
    { title: 'Atualizar o plano de manutenção preventiva', description: 'Revisar a periodicidade das manutenções do ar-condicionado e da parte elétrica.', priority: 'baixa', due: -3, shared: false, restricted: false, steps: ['Revisar o cronograma atual'] },
  ] as const
  for (const [index, demand] of demands.entries()) {
    await step(`Demanda ${index + 1}: ${demand.title}`, async () => {
      if (!demandSectors) throw new Error('Sem setores do Controle de Demandas.')
      const created = await send<{ id: string }>('/admin/test-data/demo/demand', 'POST', await fill('demand', {
        title: demand.title,
        description: demand.description,
        categoryId: category(index),
        originSectorId: demand.shared ? demandSectors.compras : demandSectors.slm,
        responsibleSectorId: demandSectors.slm,
        followUpManagerId: null,
        startDate: day(-10 + index),
        dueDate: day(demand.due),
        priority: demand.priority,
        restricted: demand.restricted,
        notes: '',
        references: '',
        reminderDays: 3,
        customFields: {},
        collaborators: [],
        collaboratorSectorIds: demand.shared ? [demandSectors.compras] : [],
        authorizedUserIds: demand.restricted ? [me.user.id] : [],
        draft: false,
        requesterId: me.user.id,
        responsibleId: me.user.id,
        status: index === 3 ? 'em_andamento' : 'nao_iniciada',
        waitingFor: '',
        suspensionReason: '',
        resumeDate: null,
      }))
      for (const [position, title] of demand.steps.entries()) {
        await send('/admin/test-data/demo/subtask', 'POST', {
          demandId: created.id,
          subtask: { title, description: '', responsibleId: me.user.id, dueDate: day(demand.due - (demand.steps.length - position) * 3), notes: '' },
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Atas e contratos: 5, com itens e uma utilização.
  // -------------------------------------------------------------------------
  const agreements = [
    { type: 'ata', number: '012/2026', subject: 'Material de expediente', category: 'material', supplier: 'Papelaria Exemplo Ltda. (fictícia)', total: '85000', from: -120, until: 245, items: [['Papel sulfite A4', 'Resma', '2000', '24.90'], ['Caneta esferográfica azul', 'Caixa', '300', '18.50']] },
    { type: 'ata', number: '018/2026', subject: 'Material de limpeza', category: 'material', supplier: 'Limpa Bem Distribuidora (fictícia)', total: '42000', from: -60, until: 305, items: [['Detergente neutro 500 ml', 'Unidade', '1500', '2.80']] },
    { type: 'contrato', number: '045/2025', subject: 'Manutenção dos elevadores', category: 'servico', supplier: 'Elevadores Exemplo S.A. (fictícia)', total: '180000', from: -300, until: 45, items: [] },
    { type: 'ata', number: '007/2026', subject: 'Periféricos de informática', category: 'material', supplier: 'InfoTec Comércio (fictícia)', total: '60000', from: -30, until: 335, items: [['Mouse óptico USB', 'Unidade', '400', '32.00'], ['Teclado ABNT2', 'Unidade', '300', '55.00']] },
    { type: 'contrato', number: '031/2024', subject: 'Curso de atendimento ao público', category: 'curso', supplier: 'Escola de Gestão Exemplo (fictícia)', total: '25000', from: -400, until: -20, items: [] },
  ] as const
  for (const agreement of agreements) {
    await step(`Ata/contrato ${agreement.number}: ${agreement.subject}`, async () => {
      if (!demandSectors) throw new Error('Sem setores do Controle de Demandas.')
      const created = await send<{ id: string }>('/admin/test-data/demo/instrument', 'POST', await fill('contractInstrument', {
        type: agreement.type,
        number: agreement.number,
        subject: agreement.subject,
        category: agreement.category,
        supplier: agreement.supplier,
        process: `SEI 0${agreement.number.replace('/', '')}-00`,
        total: agreement.total,
        validFrom: day(agreement.from),
        validUntil: day(agreement.until),
        responsibleSectorId: demandSectors.slm,
        sharedSectorIds: [],
        managerId: me.user.id,
        noticeDays: '60',
        closed: false,
        notes: 'Cadastro de demonstração.',
      }))
      for (const [position, [description, unit, registered, unitPrice]] of agreement.items.entries()) {
        await send('/admin/test-data/demo/instrument-item', 'POST', {
          instrumentId: created.id,
          item: { itemNumber: String(position + 1), description, unit, registered, unitPrice, active: true },
        })
      }
      if (agreement.items.length > 0) {
        const detail = await get<{ instrument: { items?: { id: string }[] } }>(`/demand-instruments/${created.id}`)
        const first = detail.instrument.items?.[0]
        if (first) {
          await send('/admin/test-data/demo/instrument-usage', 'POST', {
            instrumentId: created.id,
            usage: { itemId: first.id, quantity: '150', date: day(-5), document: 'Empenho 2026NE000123', note: 'Primeira compra.' },
          })
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Patrimônio: 5 bens em setores e situações diferentes.
  // -------------------------------------------------------------------------
  const assets = [
    { number: '900001', description: 'Notebook Dell Latitude 5440', sector: 'ti', room: 'Sala 3', situation: 'em_uso', brand: 'Dell', model: 'Latitude 5440', value: '6890.00' },
    { number: '900002', description: 'Mesa de reunião 8 lugares', sector: 'gabinete', room: 'Sala de reuniões', situation: 'em_uso', brand: 'Marelli', model: 'Linha Prime', value: '3450.00' },
    { number: '900003', description: 'Impressora multifuncional laser', sector: 'protocolo', room: 'Sala 12', situation: 'em_manutencao', brand: 'HP', model: 'LaserJet M428', value: '2980.00' },
    { number: '900004', description: 'Cadeira giratória com braços', sector: 'juridico', room: 'Sala 7', situation: 'ocioso', brand: 'Cavaletti', model: 'Start', value: '890.00' },
    { number: '900005', description: 'Monitor 24 polegadas', sector: 'ti', room: 'Depósito', situation: 'inservivel', brand: 'LG', model: '24MK430H', value: '799.00' },
  ] as const
  for (const asset of assets) {
    await step(`Patrimônio ${asset.number}: ${asset.description}`, async () => {
      // Já criado num clique anterior: fica como está.
      const existing = await get<{ asset: unknown }>(`/patrimony/lookup?number=${asset.number}`)
      if (existing.asset) return
      await send('/patrimony/assets', 'POST', {
        number: asset.number,
        description: asset.description,
        sectorId: sectors?.[asset.sector],
        room: asset.room,
        situation: asset.situation,
        brand: asset.brand,
        model: asset.model,
        serialNumber: `SN-${asset.number}`,
        registeredOn: day(-200),
        acquisitionValue: asset.value,
        invoice: `NF ${asset.number}`,
        supplier: 'Fornecedor Exemplo (fictício)',
        note: 'Bem de demonstração.',
      })
    })
  }
}
