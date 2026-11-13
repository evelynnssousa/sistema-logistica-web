import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createInventoryCheck, errorMessage } from '../api/modulesApi'
import { getRestock, getWeeklySummary, readRobotSheet } from '../api/operationsApi'
import type { RestockSuggestion, RobotColumns, RobotSheet, WeeklySummary } from '../api/operationsApi'
import StatCard from '../components/StatCard'
import { Alert, EmptyState, Loading } from '../components/ui/Feedback'
import { FilterSelect } from '../components/ui/Filters'

/**
 * Robô do Almoxarifado, sem inteligência artificial: lê a planilha do sistema governamental e monta
 * a conferência de inventário, sugere a reposição e mostra o resumo da semana. O robô prepara; a
 * pessoa confere e confirma. Nada é gravado sem o clique em "Criar conferência".
 */

const number = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: digits })

/** Baixa um CSV que o Excel em português abre direto (ponto e vírgula, com BOM). */
function downloadCsv(fileName: string, rows: readonly (readonly (string | number | null)[])[]) {
  const text = rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null ? '' : typeof cell === 'number' ? cell.toLocaleString('pt-BR', { useGrouping: false, maximumFractionDigits: 3 }) : cell
          // Texto que começa com =, +, - ou @ não vira fórmula no Excel.
          const safe = /^[=+\-@]/.test(value) && typeof cell !== 'number' ? `'${value}` : value
          return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
        })
        .join(';'),
    )
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function todayInBrasilia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

type Section = 'inventory' | 'restock' | 'summary'

export function WarehouseRobotTab() {
  const [section, setSection] = useState<Section>('inventory')
  return (
    <>
      <section className="ui-card ui-stacked">
        <h2>Robô do Almoxarifado</h2>
        <p className="module-notice">
          O robô faz contas e comparações, sem inteligência artificial e sem custo. Ele prepara as listas;
          quem confere e confirma é a equipe. Nada é gravado sem o seu clique.
        </p>
        <div className="robot-sections" role="tablist" aria-label="O que o robô faz">
          {([
            ['inventory', 'Inventário pela planilha do governo'],
            ['restock', 'Sugestão de reposição'],
            ['summary', 'Resumo da semana'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              className={section === key ? 'maintenance-primary-button' : 'maintenance-secondary-button'}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      {section === 'inventory' && <InventoryFromSheet />}
      {section === 'restock' && <Restock />}
      {section === 'summary' && <Summary />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Inventário pela planilha
// ---------------------------------------------------------------------------
const statusLabels = {
  code: 'Mesmo código',
  name: 'Mesmo nome',
  suggested: 'Parecido: confira',
  none: 'Sem cadastro',
} as const

type View = 'all' | 'different' | 'unmatched' | 'systemOnly'

function InventoryFromSheet() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [sheet, setSheet] = useState<RobotSheet | null>(null)
  const [columns, setColumns] = useState<RobotColumns | null>(null)
  const [choices, setChoices] = useState<Record<number, string>>({})
  const [view, setView] = useState<View>('all')
  const [title, setTitle] = useState('')
  const [referenceDate, setReferenceDate] = useState(todayInBrasilia)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function read(selected: File, chosen?: RobotColumns) {
    setBusy(true)
    setError('')
    try {
      const result = await readRobotSheet(selected, chosen)
      setSheet(result)
      setColumns(result.columns)
      // Código ou nome iguais já vêm escolhidos; os parecidos esperam a confirmação da pessoa.
      setChoices(
        Object.fromEntries(
          result.lines.map((line) => [line.line, line.match.status === 'code' || line.match.status === 'name' ? (line.match.materialId ?? '') : '']),
        ),
      )
      if (!chosen) setTitle(`Conferência pela planilha ${selected.name}`.slice(0, 160))
    } catch (err) {
      setSheet(null)
      setError(errorMessage(err, 'Não foi possível ler a planilha.'))
    } finally {
      setBusy(false)
    }
  }

  const catalogById = useMemo(() => new Map((sheet?.catalog ?? []).map((entry) => [entry.id, entry])), [sheet])

  const report = useMemo(() => {
    if (!sheet) return null
    const rows = sheet.lines.map((line) => {
      const material = choices[line.line] ? catalogById.get(choices[line.line]) ?? null : null
      const difference = material && line.quantity !== null ? Math.round((line.quantity - material.current) * 1000) / 1000 : null
      return { line, material, difference }
    })
    const used = new Map<string, number>()
    for (const row of rows) if (row.material) used.set(row.material.id, (used.get(row.material.id) ?? 0) + 1)
    const systemOnly = sheet.catalog.filter((entry) => !used.has(entry.id))
    return {
      rows,
      systemOnly,
      repeated: [...used.values()].filter((count) => count > 1).length,
      equal: rows.filter((row) => row.difference === 0).length,
      different: rows.filter((row) => row.difference !== null && row.difference !== 0).length,
      unmatched: rows.filter((row) => !row.material).length,
      toConfirm: rows.filter((row) => !row.material && row.line.match.status === 'suggested').length,
      withoutQuantity: rows.filter((row) => row.material && row.line.quantity === null).length,
    }
  }, [sheet, choices, catalogById])

  function acceptSuggestions() {
    if (!sheet) return
    setChoices((current) => {
      const next = { ...current }
      for (const line of sheet.lines) {
        if (!next[line.line] && line.match.status === 'suggested' && line.match.materialId) next[line.line] = line.match.materialId
      }
      return next
    })
  }

  function exportReport() {
    if (!sheet || !report) return
    downloadCsv(`divergencias-${referenceDate}.csv`, [
      ['Situação', 'Linha da planilha', 'Código no governo', 'Descrição no governo', 'Quantidade no governo', 'Material no sistema', 'Localização', 'Estoque interno', 'Diferença (governo − interno)'],
      ...report.rows.map((row) => [
        !row.material ? 'Falta cadastrar no sistema' : row.difference === null ? 'Sem quantidade na planilha' : row.difference === 0 ? 'Igual' : 'Quantidade diferente',
        row.line.line,
        row.line.code,
        row.line.description,
        row.line.quantity,
        row.material?.name ?? '',
        row.material?.location ?? '',
        row.material?.current ?? null,
        row.difference,
      ]),
      ...report.systemOnly.map((entry) => ['Só no sistema (não está na planilha)', null, '', '', null, entry.name, entry.location ?? '', entry.current, null]),
    ])
  }

  async function createCheck() {
    if (!report) return
    setError('')
    const totals = new Map<string, number>()
    for (const row of report.rows) {
      if (row.material && row.line.quantity !== null) {
        totals.set(row.material.id, Math.round(((totals.get(row.material.id) ?? 0) + Math.max(0, row.line.quantity)) * 1000) / 1000)
      }
    }
    if (totals.size === 0) {
      setError('Nenhuma linha tem material escolhido e quantidade. Confira as colunas e as correspondências.')
      return
    }
    if (totals.size > 500) {
      setError('Uma conferência aceita até 500 materiais. Divida a planilha (por armário ou categoria) e crie uma conferência para cada parte.')
      return
    }
    setBusy(true)
    try {
      const created = await createInventoryCheck({
        title,
        referenceDate,
        note: `Criada pelo robô a partir da planilha ${sheet?.fileName ?? ''}.`.slice(0, 500),
        items: [...totals].map(([materialId, governmentQuantity]) => ({ materialId, governmentQuantity })),
      })
      navigate(`/almoxarifado/conferencias/${created.id}`)
    } catch (err) {
      setError(errorMessage(err, 'Não foi possível criar a conferência.'))
      setBusy(false)
    }
  }

  const headers = sheet && columns ? (sheet.preview[columns.headerRow] ?? []) : []
  const width = sheet ? Math.max(0, ...sheet.preview.map((row) => row.length)) : 0
  const columnOptions = Array.from({ length: width }, (_, index) => ({
    value: String(index),
    label: `Coluna ${index + 1}${headers[index] ? `: ${headers[index]}` : ''}`,
  }))

  const visible = report?.rows.filter((row) =>
    view === 'all' ? true : view === 'different' ? row.difference !== null && row.difference !== 0 : view === 'unmatched' ? !row.material : false,
  )

  return (
    <>
      <section className="ui-card ui-stacked">
        <h2>1. Envie a planilha</h2>
        <p className="module-notice">
          Exporte o saldo do sistema do governo e envie aqui: .xlsx, .csv, .ods ou o .xls que o sistema gera.
          O robô acha as colunas sozinho; se errar, você troca abaixo. A planilha não fica guardada.
        </p>
        <label className="maintenance-form-field">
          <span>Planilha do sistema governamental</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.ods,.txt"
            disabled={busy}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              setFile(selected)
              if (selected) void read(selected)
            }}
          />
        </label>
        {busy && <Loading label="O robô está lendo a planilha..." />}
        {error && <Alert tone="error">{error}</Alert>}
      </section>

      {sheet && columns && file && report && (
        <>
          <section className="ui-card ui-stacked">
            <h2>2. Confira as colunas</h2>
            <p>
              {sheet.rowCount} linhas lidas em <strong>{sheet.fileName}</strong>. O robô encontrou {sheet.lines.length} materiais.
            </p>
            <div className="data-table-wrapper">
              <table className="data-table">
                <tbody>
                  {sheet.preview.slice(0, 8).map((row, index) => (
                    <tr key={index} className={index === columns.headerRow ? 'robot-header-row' : undefined}>
                      <th scope="row">{index + 1}</th>
                      {Array.from({ length: width }, (_, cell) => (
                        <td key={cell}>{row[cell] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="robot-columns">
              <FilterSelect
                label="Linha do cabeçalho"
                value={columns.headerRow < 0 ? "" : String(columns.headerRow)}
                onChange={(value) => setColumns({ ...columns, headerRow: value === '' ? -1 : Number(value) })}
                allLabel="Sem cabeçalho"
                options={sheet.preview.slice(0, 12).map((_, index) => ({ value: String(index), label: `Linha ${index + 1}` }))}
              />
              {([
                ['code', 'Código do material'],
                ['description', 'Descrição'],
                ['quantity', 'Quantidade'],
                ['unit', 'Unidade'],
              ] as const).map(([key, label]) => (
                <FilterSelect
                  key={key}
                  label={label}
                  value={columns[key] === null ? '' : String(columns[key])}
                  onChange={(value) => setColumns({ ...columns, [key]: value === '' ? null : Number(value) })}
                  allLabel="Nenhuma"
                  options={columnOptions}
                />
              ))}
            </div>
            <button className="maintenance-secondary-button" type="button" disabled={busy} onClick={() => void read(file, columns)}>
              Ler de novo com estas colunas
            </button>
          </section>

          <section className="ui-metrics" aria-label="Resultado da comparação">
            <StatCard icon="success" tone="white" label="Iguais" value={String(report.equal)} description="Mesma quantidade no governo e no estoque interno" />
            <StatCard icon="warning" tone="yellow" label="Quantidade diferente" value={String(report.different)} description="Governo e estoque interno não batem" />
            <StatCard icon="attention" tone="graphite" label="Sem material escolhido" value={String(report.unmatched)} description={report.toConfirm ? `${report.toConfirm} com sugestão para conferir` : 'Falta cadastrar ou escolher'} />
            <StatCard icon="inventory" tone="black" label="Só no sistema" value={String(report.systemOnly.length)} description="Materiais ativos que não estão na planilha" />
          </section>

          <section className="ui-card ui-stacked">
            <h2>3. Confira os materiais</h2>
            <p className="module-notice">
              Código ou nome iguais já vêm escolhidos. Nos parecidos, escolha o material certo ou use o botão
              abaixo para aceitar as sugestões do robô. Linhas sem material ficam fora da conferência.
            </p>
            {report.repeated > 0 && (
              <Alert tone="warning">
                {report.repeated} materiais aparecem em mais de uma linha: as quantidades serão somadas na conferência.
              </Alert>
            )}
            {report.withoutQuantity > 0 && (
              <Alert tone="warning">{report.withoutQuantity} linhas com material escolhido estão sem quantidade e ficam de fora.</Alert>
            )}
            <div className="robot-actions">
              <FilterSelect
                label="Mostrar"
                value={view === 'all' ? '' : view}
                onChange={(value) => setView((value || 'all') as View)}
                allLabel="Todas as linhas"
                options={[
                  { value: 'different', label: 'Só com quantidade diferente' },
                  { value: 'unmatched', label: 'Só sem material escolhido' },
                  { value: 'systemOnly', label: 'Só no sistema (fora da planilha)' },
                ]}
              />
              {report.toConfirm > 0 && (
                <button className="maintenance-secondary-button" type="button" onClick={acceptSuggestions}>
                  Aceitar as {report.toConfirm} sugestões
                </button>
              )}
              <button className="maintenance-secondary-button" type="button" onClick={exportReport}>
                Baixar relatório de divergências
              </button>
            </div>
            <div className="data-table-wrapper">
              {view === 'systemOnly' ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Material no sistema</th>
                      <th>Código</th>
                      <th>Localização</th>
                      <th>Estoque interno</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.systemOnly.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.name}</td>
                        <td>{entry.code ?? '—'}</td>
                        <td>{entry.location ?? '—'}</td>
                        <td>
                          {number(entry.current)} {entry.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Linha</th>
                      <th>No governo</th>
                      <th>Qtd. governo</th>
                      <th>Material no sistema</th>
                      <th>Estoque interno</th>
                      <th>Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible?.map(({ line, material, difference }) => (
                      <tr key={line.line}>
                        <td>{line.line}</td>
                        <td>
                          {line.description || '—'}
                          {line.code && <small className="central-subtext">Código {line.code}</small>}
                        </td>
                        <td>
                          {number(line.quantity, 3)} {line.unit}
                        </td>
                        <td>
                          <select
                            aria-label={`Material da linha ${line.line}`}
                            value={choices[line.line] ?? ''}
                            onChange={(event) => setChoices((current) => ({ ...current, [line.line]: event.target.value }))}
                          >
                            <option value="">— Não incluir —</option>
                            {line.match.suggestions.length > 0 && (
                              <optgroup label="Sugestões do robô">
                                {line.match.suggestions.map((suggestion) => (
                                  <option key={suggestion.id} value={suggestion.id}>
                                    {suggestion.name} ({Math.round(suggestion.score * 100)}% parecido)
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label="Todos os materiais">
                              {sheet.catalog.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.name}
                                  {entry.code ? ` · ${entry.code}` : ''}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                          <small className="central-subtext">{statusLabels[line.match.status]}</small>
                        </td>
                        <td>{material ? `${number(material.current)} ${material.unit}` : '—'}</td>
                        <td>
                          {difference === null ? '—' : difference === 0 ? 'Igual' : <strong>{difference > 0 ? `+${number(difference, 3)}` : number(difference, 3)}</strong>}
                        </td>
                      </tr>
                    ))}
                    {visible?.length === 0 && (
                      <tr>
                        <td colSpan={6}>Nenhuma linha nesta visão.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="detail-action">
            <h2>4. Crie a conferência</h2>
            <p className="module-notice">
              A conferência sai com as quantidades do governo já preenchidas, na ordem dos armários. Depois é só
              contar e digitar a quantidade real de cada material, como sempre.
            </p>
            <label className="maintenance-form-field">
              <span>Título *</span>
              <input required minLength={3} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="maintenance-form-field">
              <span>Data de referência *</span>
              <input required type="date" value={referenceDate} onChange={(event) => setReferenceDate(event.target.value)} />
            </label>
            <button
              className="maintenance-primary-button"
              type="button"
              disabled={busy || title.trim().length < 3 || !referenceDate}
              onClick={() => void createCheck()}
            >
              Criar conferência
            </button>
            {error && <Alert tone="error">{error}</Alert>}
          </section>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Reposição
// ---------------------------------------------------------------------------
function Restock() {
  const [months, setMonths] = useState('3')
  const [data, setData] = useState<{ withInstruments: boolean; suggestions: RestockSuggestion[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getRestock(Number(months))
      .then((result) => {
        if (active) {
          setError('')
          setData(result)
        }
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível calcular a reposição.'))
      })
    return () => {
      active = false
    }
  }, [months])

  function exportList() {
    if (!data) return
    downloadCsv(`reposicao-${months}-meses.csv`, [
      ['Material', 'Código', 'Unidade', 'Disponível', 'Mínimo', 'Consumo médio por mês', 'Dura (meses)', 'Sugestão de compra', 'Motivo', ...(data.withInstruments ? ['Atas e contratos com saldo'] : [])],
      ...data.suggestions.map((item) => [
        item.name,
        item.code ?? '',
        item.unit,
        item.available,
        item.minimum,
        item.monthlyAverage,
        item.coverageMonths,
        item.suggested,
        item.reason === 'below_minimum' ? 'Abaixo do mínimo' : 'Não dura o período',
        ...(data.withInstruments ? [item.instruments.map((hint) => `${hint.number}: ${hint.description} (saldo ${number(hint.balance)})`).join(' | ')] : []),
      ]),
    ])
  }

  return (
    <section className="ui-card ui-stacked">
      <h2>Sugestão de reposição</h2>
      <p className="module-notice">
        O robô usa o consumo médio dos últimos 12 meses (pedidos entregues) e o estoque disponível (físico menos
        reservado). A sugestão é quanto comprar para durar o período escolhido, nunca abaixo do estoque mínimo. É
        uma conta, não uma ordem: confira antes de pedir.
      </p>
      <div className="robot-actions">
        <FilterSelect
          label="O estoque deve durar"
          value={months}
          onChange={(value) => setMonths(value || '3')}
          options={[1, 2, 3, 4, 6, 12].map((value) => ({ value: String(value), label: value === 1 ? '1 mês' : `${value} meses` }))}
        />
        <button className="maintenance-secondary-button" type="button" disabled={!data?.suggestions.length} onClick={exportList}>
          Baixar lista de compras
        </button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!data && !error && <Loading label="Calculando..." />}
      {data && data.suggestions.length === 0 && (
        <EmptyState title="Nada a repor">Todos os materiais com consumo duram o período escolhido e estão acima do mínimo.</EmptyState>
      )}
      {data && data.suggestions.length > 0 && (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th>
                <th>Disponível</th>
                <th>Mínimo</th>
                <th>Consumo por mês</th>
                <th>Dura</th>
                <th>Comprar</th>
                {data.withInstruments && <th>Atas e contratos com saldo</th>}
              </tr>
            </thead>
            <tbody>
              {data.suggestions.map((item) => (
                <tr key={item.materialId}>
                  <td>
                    {item.name}
                    <small className="central-subtext">
                      {item.reason === 'below_minimum' ? 'Abaixo do mínimo' : 'Não dura o período'}
                      {item.location ? ` · ${item.location}` : ''}
                    </small>
                  </td>
                  <td>
                    {number(item.available)} {item.unit}
                  </td>
                  <td>{number(item.minimum)}</td>
                  <td>{number(item.monthlyAverage)}</td>
                  <td>{item.coverageMonths === null ? 'Sem consumo' : `${number(item.coverageMonths, 1)} meses`}</td>
                  <td>
                    <strong>
                      {number(item.suggested)} {item.unit}
                    </strong>
                  </td>
                  {data.withInstruments && (
                    <td>
                      {item.instruments.length === 0
                        ? '—'
                        : item.instruments.map((hint) => (
                            <span key={hint.itemId} className="central-subtext">
                              <Link to={`/demandas/atas/${hint.instrumentId}`}>{hint.number}</Link>: {hint.description} (saldo {number(hint.balance)} {hint.unit})
                            </span>
                          ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Resumo da semana
// ---------------------------------------------------------------------------
function Summary() {
  const [data, setData] = useState<{ enabled: boolean; emailConfigured: boolean; summary: WeeklySummary } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getWeeklySummary()
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err, 'Não foi possível montar o resumo.'))
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <Alert tone="error">{error}</Alert>
  if (!data) return <Loading label="Montando o resumo..." />
  return (
    <>
      <section className="ui-metrics" aria-label="Resumo da semana">
        <StatCard icon="warning" tone="yellow" label="Abaixo do mínimo" value={String(data.summary.belowMinimum)} description="Materiais com estoque menor que o mínimo" />
        <StatCard icon="stock" tone="black" label="A repor" value={String(data.summary.restockCount)} description="Sugestão para 3 meses de consumo" />
        <StatCard icon="waiting" tone="white" label="Pedidos aguardando" value={String(data.summary.pendingCount)} description="Pendentes ou em análise" />
        <StatCard icon="inventory" tone="graphite" label="Conferências abertas" value={String(data.summary.openChecks)} description="Inventários em andamento" />
      </section>
      <section className="ui-card ui-stacked">
        <h2>E-mail de segunda-feira</h2>
        {data.enabled ? (
          <p>
            Ligado: toda segunda-feira, a partir das 7h, a equipe do Almoxarifado recebe estes números por e-mail e
            na central de notificações. O e-mail leva só as contagens, sem valores ou nomes.
          </p>
        ) : (
          <p>
            Desligado. Para ligar, um administrador vai em <strong>Configurações → Notificações</strong> e marca
            "Enviar à equipe do Almoxarifado o resumo semanal do robô".
          </p>
        )}
        {data.enabled && !data.emailConfigured && (
          <Alert tone="warning">
            O serviço de e-mail ainda não foi ativado pela instituição: o resumo fica só na central de notificações.
          </Alert>
        )}
      </section>
    </>
  )
}
