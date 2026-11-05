/**
 * Relatório individual, montado uma vez e entregue em PDF ou CSV. Sem dependência nova: o PDF só
 * tem texto, em fonte padrão, e isso basta para um registro de atendimento.
 */

export type ReportSection = {
  heading: string
  /** Pares de rótulo e valor. */
  rows?: readonly (readonly [string, string])[]
  /** Linhas de uma lista, como os itens do histórico. */
  entries?: readonly string[]
}

export type ReportDocument = {
  title: string
  subtitle: string
  generatedAt: Date
  generatedBy: string
  sections: readonly ReportSection[]
}

const generatedFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

function footerOf(document: ReportDocument) {
  return `Gerado em ${generatedFormat.format(document.generatedAt)} por ${document.generatedBy}`
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Uma célula iniciada por = + - @ viraria fórmula ao abrir na planilha. */
function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

export function renderReportCsv(document: ReportDocument) {
  const lines: string[][] = [
    ['Relatório', document.title],
    ['Referência', document.subtitle],
    ['Geração', footerOf(document)],
  ]
  for (const section of document.sections) {
    for (const [label, value] of section.rows ?? []) lines.push([section.heading, label, value])
    for (const entry of section.entries ?? []) lines.push([section.heading, '', entry])
  }
  // O BOM faz o Excel reconhecer os acentos.
  return `﻿${lines.map((line) => line.map(csvCell).join(';')).join('\r\n')}`
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const pageWidth = 595
const pageHeight = 842
const margin = 50
const contentWidth = pageWidth - margin * 2

const replacements: Record<string, string> = {
  '→': '->',
  '—': '-',
  '–': '-',
  '…': '...',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '·': '-',
}

/** A fonte padrão só tem o alfabeto latino. O resto é trocado, nunca quebra o arquivo. */
function toLatin1(text: string) {
  return text
    .replace(/[→—–…“”‘’·]/g, (char) => replacements[char])
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[^ -ÿ]/g, '?')
}

function escapePdf(text: string) {
  return text.replace(/[\\()]/g, '\\$&')
}

// Largura aproximada da Helvetica, em proporção do corpo da letra. Sobra um pouco, sem cortar texto.
function textWidth(text: string, size: number) {
  let units = 0
  for (const char of text) {
    if (/[il.,;:!|'jft ]/.test(char)) units += 0.3
    else if (/[A-ZÀ-ÝmwMW]/.test(char)) units += 0.72
    else units += 0.56
  }
  return units * size
}

function wrap(text: string, size: number, width: number) {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let piece = word
    // Palavra maior que a linha, como um endereço, é cortada para não vazar da página.
    while (textWidth(piece, size) > width) {
      if (current) {
        lines.push(current)
        current = ''
      }
      let length = piece.length - 1
      while (length > 1 && textWidth(piece.slice(0, length), size) > width) length -= 1
      lines.push(piece.slice(0, length))
      piece = piece.slice(length)
    }
    const candidate = current ? `${current} ${piece}` : piece
    if (textWidth(candidate, size) > width) {
      lines.push(current)
      current = piece
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

type PdfLine = { text: string; size: number; bold: boolean; x: number; gapBefore: number }

function layout(document: ReportDocument) {
  const lines: PdfLine[] = []
  const add = (text: string, size: number, bold: boolean, gapBefore = 0, indent = 0) => {
    wrap(toLatin1(text), size, contentWidth - indent).forEach((line, index) => {
      lines.push({ text: line, size, bold, x: margin + indent, gapBefore: index === 0 ? gapBefore : 0 })
    })
  }

  add('JUCESP - Serviços de Logística e Manutenção', 9, true)
  add(document.title, 16, true, 6)
  add(document.subtitle, 10, false, 2)
  for (const section of document.sections) {
    add(section.heading, 12, true, 14)
    for (const [label, value] of section.rows ?? []) {
      add(`${label}: ${value || '-'}`, 10, false, 3)
    }
    for (const entry of section.entries ?? []) add(`- ${entry}`, 10, false, 3, 6)
  }
  return lines
}

function paginate(lines: readonly PdfLine[]) {
  const pages: PdfLine[][] = [[]]
  let y = pageHeight - margin
  for (const line of lines) {
    const height = line.size * 1.3 + line.gapBefore
    if (y - height < margin + 20) {
      pages.push([])
      y = pageHeight - margin
    }
    y -= height
    pages[pages.length - 1].push(line)
  }
  return pages
}

function pageStream(lines: readonly PdfLine[], footer: string) {
  const parts: string[] = []
  let y = pageHeight - margin
  for (const line of lines) {
    y -= line.size * 1.3 + line.gapBefore
    parts.push(
      `BT /${line.bold ? 'F2' : 'F1'} ${line.size} Tf ${line.x} ${y.toFixed(2)} Td (${escapePdf(line.text)}) Tj ET`,
    )
  }
  parts.push(`BT /F1 8 Tf ${margin} 30 Td (${escapePdf(toLatin1(footer))}) Tj ET`)
  return parts.join('\n')
}

export function renderReportPdf(document: ReportDocument): Buffer {
  const pages = paginate(layout(document))
  const footer = footerOf(document)

  // Objetos: 1 catálogo, 2 páginas, 3 e 4 fontes; depois, um par página e conteúdo por página.
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 5 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'

  pages.forEach((lines, index) => {
    const pageId = pageIds[index]
    const stream = pageStream(lines, `${footer} - Página ${index + 1} de ${pages.length}`)
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  })

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'latin1')
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
