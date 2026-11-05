import type { ReactNode } from 'react'
import { periodOptions } from '../../app/period'
import type { PeriodFilter } from '../../app/period'
import Icon from './Icon'

/** Barra única de filtros, igual em todas as telas. */
export function FilterBar({
  label,
  children,
  canClear,
  onClear,
}: {
  label: string
  children: ReactNode
  canClear?: boolean
  onClear?: () => void
}) {
  return (
    <div className="module-filters ui-filter-bar" role="group" aria-label={label}>
      {children}
      {onClear && (
        <button type="button" className="ui-clear-filters" disabled={!canClear} onClick={onClear}>
          <Icon name="clear" size={18} />
          Limpar filtros
        </button>
      )}
    </div>
  )
}

/** Controle suspenso nativo: teclado, leitor de tela e celular funcionam sem adaptação. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  allLabel?: string
}) {
  return (
    <label className="ui-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {allLabel && <option value="">{allLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function SearchField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="ui-filter-field ui-filter-search">
      <span>{label}</span>
      <span className="ui-search-input">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={value}
          placeholder={placeholder}
          maxLength={120}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </label>
  )
}

export function PeriodFields({ filter, onChange, label = 'Período' }: { filter: PeriodFilter; onChange?: () => void; label?: string }) {
  return (
    <>
      <FilterSelect
        label={label}
        value={filter.period}
        options={periodOptions}
        onChange={(value) => {
          filter.setPeriod(value)
          onChange?.()
        }}
      />
      {filter.period === 'custom' && (
        <>
          <label className="ui-filter-field">
            <span>De</span>
            <input
              type="date"
              value={filter.from}
              onChange={(event) => {
                filter.setFrom(event.target.value)
                onChange?.()
              }}
            />
          </label>
          <label className="ui-filter-field">
            <span>Até</span>
            <input
              type="date"
              value={filter.to}
              onChange={(event) => {
                filter.setTo(event.target.value)
                onChange?.()
              }}
            />
          </label>
        </>
      )}
    </>
  )
}
