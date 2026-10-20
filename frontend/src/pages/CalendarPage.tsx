import { useState } from 'react'

const calendarViews = ['Mês', 'Semana', 'Dia'] as const
const calendarModules = ['Manutenção', 'Frota', 'Passagens Aéreas'] as const

function CalendarPage() {
  const [activeView, setActiveView] =
    useState<(typeof calendarViews)[number]>('Mês')

  return (
    <div className="admin-module-page calendar-page">
      <section className="admin-page-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Calendário</h1>
          <p>
            Visualize e acompanhe os agendamentos dos serviços e solicitações.
          </p>
        </div>
      </section>

      <section className="admin-data-card" aria-label="Calendário de serviços">
        <div className="calendar-toolbar">
          <div className="calendar-period-controls">
            <button type="button" disabled aria-label="Período anterior">
              ←
            </button>
            <button type="button" disabled aria-label="Período seguinte">
              →
            </button>
            <span>Período disponível após integração</span>
          </div>
          <div className="calendar-view-controls" aria-label="Visualização">
            {calendarViews.map((view) => (
              <button
                key={view}
                type="button"
                className={activeView === view ? 'active' : ''}
                aria-pressed={activeView === view}
                onClick={() => setActiveView(view)}
              >
                {view}
              </button>
            ))}
          </div>
        </div>

        <div className="calendar-filter-row" aria-label="Filtrar por módulo">
          {calendarModules.map((module) => (
            <label key={module} className="calendar-module-filter">
              <input type="checkbox" disabled />
              <span>{module}</span>
            </label>
          ))}
          <span className="calendar-filter-note">
            Filtros disponíveis quando houver eventos.
          </span>
        </div>

        <div className="calendar-empty-state">
          <span aria-hidden="true">▦</span>
          <strong>Nenhum evento disponível</strong>
          <p>
            Os agendamentos aparecerão aqui quando houver dados reais e a
            integração com o calendário estiver disponível.
          </p>
          <small>Integração com Google Calendar preparada para etapa futura.</small>
        </div>
      </section>
    </div>
  )
}

export default CalendarPage
