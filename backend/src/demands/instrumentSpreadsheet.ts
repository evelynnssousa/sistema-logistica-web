import type { Sheet } from '../reports/xlsxDocument.js'

/**
 * Robô de atas pelo Excel (14/11/2026). Lê a primeira aba de uma planilha com:
 *   - no alto, os dados da ata em pares "Rótulo | valor" (Tipo, Número, Objeto, Fornecedor...);
 *   - depois, a tabela de itens, achada pelo cabeçalho (Descrição, Unidade, Quantidade, Valor unitário).
 * Também aceita a planilha só com os itens, como um quadro comparativo exportado. Nada é gravado
 * aqui: a tela mostra o resultado para a pessoa conferir antes de salvar.
 */

export type ParsedInstrumentFields = {
  type: 'ata' | 'contrato' | null
  number: string | null
  subject: string | null
  category: 'material' | 'servico' | 'curso' | 'outro' | null
  supplier: string | null
  process: string | null
  total: number | null
  validFrom: string | null
  validUntil: string | null
  sectorName: string | null
  noticeDays: number | null
}

export type ParsedItem = {
  row: number
  itemNumber: string | null
  description: string
  unit: string
  registered: number
  unitPrice: number
}

export type ParsedInstrumentSheet = {
  fields: ParsedInstrumentFields
  items: ParsedItem[]
  itemsTotal: number
  warnings: string[]
}

export const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[º°ª]/g, '')
    .replace(/[:*().]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const fieldLabels: Record<keyof ParsedInstrumentFields, string[]> = {
  type: ['tipo', 'tipo do instrumento'],
  number: ['numero', 'numero da ata', 'numero do contrato', 'ata', 'contrato', 'n da ata', 'n do contrato'],
  subject: ['objeto', 'objeto da ata', 'objeto do contrato'],
  category: ['categoria', 'natureza'],
  supplier: ['fornecedor', 'empresa', 'contratada', 'fornecedor vencedor', 'detentora'],
  process: ['processo', 'processo sei', 'numero do processo', 'n do processo', 'sei'],
  total: ['valor total', 'valor global', 'valor da ata', 'valor do contrato'],
  validFrom: ['inicio da vigencia', 'vigencia inicio', 'data de inicio', 'inicio', 'data de assinatura'],
  validUntil: ['fim da vigencia', 'vigencia fim', 'termino da vigencia', 'data de fim', 'termino', 'validade', 'vigente ate'],
  sectorName: ['setor responsavel', 'setor', 'unidade responsavel'],
  noticeDays: ['aviso de vencimento', 'aviso de vencimento dias', 'aviso dias', 'aviso'],
}

const headerWords = {
  itemNumber: ['item', 'n', 'n item', 'numero do item', 'lote', 'cod', 'codigo'],
  description: ['descricao', 'descricao do item', 'especificacao', 'produto', 'material', 'servico', 'discriminacao', 'objeto'],
  unit: ['unidade', 'un', 'und', 'unid', 'unidade de medida', 'medida', 'um'],
  quantity: ['quantidade', 'qtd', 'qtde', 'quant', 'quantidade registrada', 'qtd registrada', 'quantitativo'],
  unitPrice: ['valor unitario', 'preco unitario', 'vl unitario', 'vl unit', 'valor unit', 'preco unit', 'unitario', 'valor registrado'],
}

/** Número em qualquer formato comum: 1.234,56 · 1234.56 · R$ 12,50 · 1234 · (o Excel grava 1234.5). */
export function parseNumber(raw: string): number | null {
  const text = raw.replace(/r\$|\s/gi, '').replace(/[^\d,.-]/g, '')
  if (!text || !/\d/.test(text)) return null
  let normalized = text
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  } else if (comma >= 0) {
    normalized = text.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) {
    normalized = text.replace(/\./g, '')
  }
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

/** Data em dd/mm/aaaa, aaaa-mm-dd ou o número de série do Excel. Devolve aaaa-mm-dd. */
export function parseDate(raw: string): string | null {
  const text = raw.trim()
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text)
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
    return validDate(year, Number(match[2]), Number(match[1]))
  }
  match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]))
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    // Série do Excel: dias desde 30/12/1899.
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(text)) * 86_400_000)
    return validDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
  }
  return null
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  if (year < 2000 || year > 2100) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function readType(raw: string): ParsedInstrumentFields['type'] {
  const text = normalize(raw)
  if (text.startsWith('ata') || text.includes('registro de preco')) return 'ata'
  if (text.startsWith('contrato')) return 'contrato'
  return null
}

function readCategory(raw: string): ParsedInstrumentFields['category'] {
  const text = normalize(raw)
  if (text.startsWith('material') || text.startsWith('materiais') || text.startsWith('compra')) return 'material'
  if (text.startsWith('servico')) return 'servico'
  if (text.startsWith('curso') || text.startsWith('capacitacao') || text.startsWith('treinamento')) return 'curso'
  if (text.startsWith('outro')) return 'outro'
  return null
}

function findColumn(header: string[], words: string[]) {
  const cells = header.map(normalize)
  // Igualdade primeiro; depois "começa com", para "Descrição detalhada do item" ou "Qtd. total".
  const exact = cells.findIndex((cell) => words.includes(cell))
  if (exact >= 0) return exact
  return cells.findIndex((cell) => cell.length > 0 && words.some((word) => word.length > 2 && cell.startsWith(word)))
}

function locateItems(rows: string[][]) {
  for (let index = 0; index < rows.length; index += 1) {
    const header = rows[index]
    const columns = {
      itemNumber: findColumn(header, headerWords.itemNumber),
      description: findColumn(header, headerWords.description),
      unit: findColumn(header, headerWords.unit),
      quantity: findColumn(header, headerWords.quantity),
      unitPrice: findColumn(header, headerWords.unitPrice),
    }
    if (columns.description >= 0 && columns.quantity >= 0 && columns.unitPrice >= 0) return { index, columns }
  }
  return null
}

export function parseInstrumentSheet(rows: string[][]): ParsedInstrumentSheet {
  const warnings: string[] = []
  const fields: ParsedInstrumentFields = {
    type: null, number: null, subject: null, category: null, supplier: null, process: null,
    total: null, validFrom: null, validUntil: null, sectorName: null, noticeDays: null,
  }
  const table = locateItems(rows)
  const headerRow = table ? table.index : rows.length

  // Dados da ata: pares "rótulo | valor" acima da tabela (ou na mesma linha, valor na célula seguinte).
  for (const row of rows.slice(0, headerRow)) {
    for (let column = 0; column < row.length - 1; column += 1) {
      const label = normalize(row[column])
      // O valor é a célula logo à direita: a seguinte pode ser só uma explicação, como no modelo.
      const value = (row[column + 1] ?? '').trim()
      if (!label || !value) continue
      const key = (Object.keys(fieldLabels) as (keyof ParsedInstrumentFields)[]).find((name) => fieldLabels[name].includes(label))
      if (!key || fields[key] !== null) continue
      if (key === 'type') fields.type = readType(value)
      else if (key === 'category') fields.category = readCategory(value)
      else if (key === 'total') fields.total = parseNumber(value)
      else if (key === 'noticeDays') fields.noticeDays = parseNumber(value)
      else if (key === 'validFrom' || key === 'validUntil') {
        fields[key] = parseDate(value)
        if (!fields[key]) warnings.push(`A data em "${row[column]}" não foi reconhecida: use dd/mm/aaaa.`)
      } else fields[key] = value.slice(0, key === 'subject' ? 1000 : key === 'supplier' ? 200 : 60)
      break
    }
  }

  const items: ParsedItem[] = []
  if (!table) {
    warnings.push('Não achei a tabela de itens. Ela precisa de um cabeçalho com Descrição, Quantidade e Valor unitário.')
  } else {
    const { columns } = table
    for (let index = table.index + 1; index < rows.length; index += 1) {
      const row = rows[index]
      const line = index + 1
      const description = (row[columns.description] ?? '').trim()
      if (!description) continue
      if (/^(sub)?total\b/.test(normalize(description))) continue
      const registered = parseNumber(row[columns.quantity] ?? '')
      const unitPrice = parseNumber(row[columns.unitPrice] ?? '')
      if (registered === null || registered < 0 || unitPrice === null || unitPrice < 0) {
        warnings.push(`Linha ${line}: quantidade ou valor unitário inválido; o item "${description.slice(0, 60)}" ficou de fora.`)
        continue
      }
      let unit = columns.unit >= 0 ? (row[columns.unit] ?? '').trim() : ''
      if (!unit) {
        unit = 'unidade'
        warnings.push(`Linha ${line}: sem unidade; usei "unidade". Confira antes de salvar.`)
      }
      items.push({
        row: line,
        itemNumber: columns.itemNumber >= 0 && columns.itemNumber !== columns.description ? (row[columns.itemNumber] ?? '').trim().slice(0, 20) || null : null,
        description: description.slice(0, 500),
        unit: unit.slice(0, 40),
        registered: Math.round(registered * 100) / 100,
        unitPrice: Math.round(unitPrice * 10_000) / 10_000,
      })
      if (items.length >= 500) {
        warnings.push('A planilha tem mais de 500 itens: só os 500 primeiros foram lidos.')
        break
      }
    }
    if (items.length === 0) warnings.push('A tabela de itens foi achada, mas nenhum item tinha descrição, quantidade e valor válidos.')
  }

  const itemsTotal = Math.round(items.reduce((sum, item) => sum + item.registered * item.unitPrice, 0) * 100) / 100
  if (fields.total === null && items.length > 0) fields.total = itemsTotal
  else if (fields.total !== null && items.length > 0 && Math.abs(fields.total - itemsTotal) > 0.05) {
    warnings.push(
      `O valor total informado (${money(fields.total)}) é diferente da soma dos itens (${money(itemsTotal)}). Confira antes de salvar.`,
    )
  }
  if (fields.validFrom && fields.validUntil && fields.validUntil < fields.validFrom) {
    warnings.push('O fim da vigência está antes do início.')
  }
  if (fields.noticeDays !== null && (!Number.isInteger(fields.noticeDays) || fields.noticeDays < 0 || fields.noticeDays > 365)) {
    warnings.push('O aviso de vencimento precisa ser um número de 0 a 365 dias; usei 90.')
    fields.noticeDays = null
  }
  return { fields, items, itemsTotal, warnings }
}

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** Modelo para baixar: os dados da ata no alto e a tabela de itens, com um exemplo preenchido. */
export function instrumentTemplate(): Sheet[] {
  return [
    {
      name: 'Ata',
      rows: [
        ['MODELO DE ATA OU CONTRATO PARA O SISTEMA SLM. Preencha as colunas B e a tabela de itens; não mude os títulos.'],
        [],
        ['Tipo', 'Ata', 'Ata ou Contrato'],
        ['Número', '12/2026'],
        ['Objeto', 'Material de expediente'],
        ['Categoria', 'Material', 'Material, Serviço, Curso ou Outro'],
        ['Fornecedor', 'Papelaria Exemplo Ltda.'],
        ['Processo SEI', '151.00000/2026-00'],
        ['Valor total', '', 'Em branco: o sistema soma os itens'],
        ['Início da vigência', '01/01/2026', 'dd/mm/aaaa'],
        ['Fim da vigência', '31/12/2026', 'dd/mm/aaaa'],
        ['Setor responsável', 'Almoxarifado', 'Nome do setor no Controle de Demandas'],
        ['Aviso de vencimento (dias)', 90, 'Antecedência do aviso de renovação'],
        [],
        ['Item', 'Descrição', 'Unidade', 'Quantidade', 'Valor unitário', 'Valor total'],
        ['1', 'Papel A4 75 g/m², caixa com 10 resmas', 'caixa', 120, 189.9, 22788],
        ['2', 'Caneta esferográfica azul', 'unidade', 500, 1.35, 675],
      ],
    },
  ]
}
