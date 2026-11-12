import { useId, useState } from 'react'
import Icon from './ui/Icon'

/**
 * Baixa a planilha (.xlsx) do Almoxarifado ou da Frota do período escolhido. O período vai como
 * instantes: do início do primeiro dia ao fim do último, no horário de quem baixa.
 */
type Kind = 'warehouse' | 'fleet'

const paths: Record<Kind, string> = {
  warehouse: '/api/reports/warehouse/spreadsheet',
  fleet: '/api/reports/fleet/spreadsheet',
}

const toInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

function localDay(value: string, offsetDays = 0) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day + offsetDays)
}

function spreadsheetUrl(kind: Kind, from: string, to: string) {
  const query = new URLSearchParams({
    from: localDay(from).toISOString(),
    to: localDay(to, 1).toISOString(),
  })
  return `${paths[kind]}?${query.toString()}`
}

function SpreadsheetDownload({ kind, title, description }: { kind: Kind; title: string; description: string }) {
  const today = new Date()
  const [from, setFrom] = useState(toInput(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(toInput(today))
  const id = useId()
  const valid = Boolean(from && to && from <= to)

  return (
    <section className="ui-card ui-stacked spreadsheet-download" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="spreadsheet-download-note">{description}</p>
      <div className="spreadsheet-download-fields">
        <label className="maintenance-form-field">
          <span>De</span>
          <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="maintenance-form-field">
          <span>Até</span>
          <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </label>
        {valid ? (
          <a className="maintenance-secondary-button" href={spreadsheetUrl(kind, from, to)} download>
            <Icon name="download" size={18} />
            Baixar planilha (Excel)
          </a>
        ) : (
          <span className="spreadsheet-download-note" role="status">Escolha um período válido.</span>
        )}
      </div>
    </section>
  )
}

export default SpreadsheetDownload
