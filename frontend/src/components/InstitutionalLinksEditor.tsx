import type { InstitutionalLinks, InstitutionalOptions, SectorLink } from '../auth/usersApi'
import { directorateRoleLabels } from '../auth/usersApi'

/**
 * Vínculos institucionais de uma pessoa: participação na DA e setores de atuação. São independentes
 * da lotação e da equipe SLM, e somam. Usado na aprovação e na página do usuário.
 */
function InstitutionalLinksEditor({
  options,
  value,
  disabled = false,
  onChange,
}: {
  options: InstitutionalOptions
  value: InstitutionalLinks
  disabled?: boolean
  onChange: (value: InstitutionalLinks) => void
}) {
  const linkOf = (sectorId: string) => value.sectors.find((item) => item.sectorId === sectorId)

  function updateSector(sectorId: string, changes: Partial<SectorLink>) {
    onChange({
      ...value,
      sectors: value.sectors.map((item) => (item.sectorId === sectorId ? { ...item, ...changes } : item)),
    })
  }

  function toggleSector(sectorId: string, included: boolean) {
    onChange({
      ...value,
      sectors: included
        ? [...value.sectors, { sectorId, role: 'colaborador', chefia: false, function: null, canCreate: true, seesSector: true }]
        : value.sectors.filter((item) => item.sectorId !== sectorId),
    })
  }

  // Um vínculo em setor já desativado continua visível: retirá-lo é uma decisão expressa.
  const sectors = [
    ...options.sectors,
    ...value.sectors
      .filter((item) => !options.sectors.some((sector) => sector.id === item.sectorId))
      .map((item) => ({ id: item.sectorId, name: `${item.sectorName ?? 'Setor'} (desativado)`, isSlm: false })),
  ]

  return (
    <div className="demand-stack institutional-links">
      <fieldset className="demand-checks">
        <legend>Diretoria Administrativa (DA)</legend>
        <label>
          <input
            type="checkbox"
            checked={value.directorate !== null}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, directorate: event.target.checked ? { role: 'diretor', function: null } : null })
            }
          />
          {directorateRoleLabels.diretor}
        </label>
      </fieldset>

      {value.directorate && (
        <div className="demand-form-grid">
          <label className="maintenance-form-field">
            <span>Função exercida</span>
            <input
              maxLength={120}
              value={value.directorate.function ?? ''}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  directorate: { role: 'diretor', function: event.target.value || null },
                })
              }
            />
          </label>
        </div>
      )}

      <fieldset className="demand-checks">
        <legend>Setores ou unidades de atuação</legend>
        {sectors.length === 0 && (
          <p className="demand-muted">Nenhum setor cadastrado. Os setores são definidos em Configurações.</p>
        )}
        {sectors.map((sector) => {
          const link = linkOf(sector.id)
          return (
            <div key={sector.id} className="institutional-sector">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(link)}
                  disabled={disabled}
                  onChange={(event) => toggleSector(sector.id, event.target.checked)}
                />
                {sector.name}
              </label>
              {link && (
                <div className="demand-form-grid">
                  <label className="maintenance-form-field">
                    <span>Papel em {sector.name}</span>
                    <select
                      value={link.role === 'responsavel' ? 'chefia' : 'colaborador'}
                      disabled={disabled}
                      onChange={(event) =>
                        updateSector(sector.id, {
                          chefia: event.target.value === 'chefia',
                          role: event.target.value === 'colaborador' ? 'colaborador' : 'responsavel',
                        })
                      }
                    >
                      <option value="colaborador">Servidor do setor</option>
                      <option value="chefia">Chefe do setor</option>
                    </select>
                  </label>
                  <label className="maintenance-form-field">
                    <span>Função em {sector.name}</span>
                    <input
                      maxLength={120}
                      value={link.function ?? ''}
                      disabled={disabled}
                      onChange={(event) => updateSector(sector.id, { function: event.target.value || null })}
                    />
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </fieldset>
    </div>
  )
}

export default InstitutionalLinksEditor
