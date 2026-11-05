import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  createDemand,
  demandPriorityLabels,
  demandStatusLabels,
  fetchDemand,
  frequencyLabels,
  publishDemand,
  updateDemand,
  uploadDemandAttachment,
} from '../../api/demandsApi'
import type { DemandDetail, DemandStatus, RecurrenceEnd } from '../../api/demandsApi'
import { errorMessage } from '../../api/modulesApi'
import { useAuthenticatedUser } from '../../auth/UserContext'
import { Alert, Loading } from '../../components/ui/Feedback'
import { emptyRecurrence, recurrenceDraftFrom, recurrencePayload } from './demandRecurrence'
import type { RecurrenceDraft } from './demandRecurrence'
import { useDemands } from './useDemands'

const weekdayChoices = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const initialStatuses: DemandStatus[] = ['nao_iniciada', 'em_andamento', 'aguardando_terceiros', 'aguardando_autorizacao', 'suspensa']

/** Mesmos campos na criação e na alteração da regra de uma série. */
export function RecurrenceFields({ draft, onChange }: { draft: RecurrenceDraft; onChange: (draft: RecurrenceDraft) => void }) {
  const set = (values: Partial<RecurrenceDraft>) => onChange({ ...draft, ...values })
  const custom = draft.frequency === 'personalizada'
  const unit = custom
    ? draft.unit
    : { diaria: 'dia', quinzenal: 'dia', semanal: 'semana', anual: 'ano' }[draft.frequency] ?? 'mes'

  return (
    <div className="demand-recurrence">
      <div className="demand-form-grid">
        <label className="maintenance-form-field">
          <span>Repetir a demanda a cada</span>
          <select value={draft.frequency} onChange={(event) => set({ frequency: event.target.value })}>
            {Object.entries(frequencyLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {custom && (
          <>
            <label className="maintenance-form-field">
              <span>Intervalo</span>
              <input type="number" min="1" max="365" required value={draft.interval} onChange={(event) => set({ interval: event.target.value })} />
            </label>
            <label className="maintenance-form-field">
              <span>Unidade</span>
              <select value={draft.unit} onChange={(event) => set({ unit: event.target.value })}>
                <option value="dia">Dias</option>
                <option value="semana">Semanas</option>
                <option value="mes">Meses</option>
                <option value="ano">Anos</option>
              </select>
            </label>
          </>
        )}
        <label className="maintenance-form-field">
          <span>Data inicial</span>
          <input type="date" required value={draft.startDate} onChange={(event) => set({ startDate: event.target.value })} />
        </label>
      </div>

      {unit === 'semana' && (
        <fieldset className="demand-checks demand-checks-inline">
          <legend>Dias da semana (sem escolha, vale o dia da data inicial)</legend>
          {weekdayChoices.map((name, day) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={draft.weekdays.includes(day)}
                onChange={(event) =>
                  set({
                    weekdays: event.target.checked
                      ? [...draft.weekdays, day]
                      : draft.weekdays.filter((item) => item !== day),
                  })
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
      )}

      {(unit === 'mes' || unit === 'ano') && (
        <label className="maintenance-form-field">
          <span>Dias do mês, separados por vírgula (ex.: 5, 20)</span>
          <input
            inputMode="numeric"
            placeholder={`Sem preencher, vale o dia ${Number(draft.startDate.slice(8, 10)) || ''}`}
            value={draft.monthDays}
            onChange={(event) => set({ monthDays: event.target.value })}
          />
          <small className="demand-muted">
            Cada dia gera uma demanda separada. Dia inexistente no mês, como 31 em abril, vira o último dia do mês.
          </small>
        </label>
      )}

      <div className="demand-form-grid">
        <label className="maintenance-form-field">
          <span>Encerramento</span>
          <select value={draft.endType} onChange={(event) => set({ endType: event.target.value as RecurrenceEnd['type'] })}>
            <option value="sem_fim">Sem data definida</option>
            <option value="quantidade">Após uma quantidade de ocorrências</option>
            <option value="data">Em uma data específica</option>
          </select>
        </label>
        {draft.endType === 'quantidade' && (
          <label className="maintenance-form-field">
            <span>Quantidade de ocorrências</span>
            <input type="number" min="1" max="1000" required value={draft.endCount} onChange={(event) => set({ endCount: event.target.value })} />
          </label>
        )}
        {draft.endType === 'data' && (
          <label className="maintenance-form-field">
            <span>Data de encerramento</span>
            <input type="date" required value={draft.endDate} onChange={(event) => set({ endDate: event.target.value })} />
          </label>
        )}
        <label className="maintenance-form-field">
          <span>Gerar quantos dias antes do prazo</span>
          <input type="number" min="0" max="60" value={draft.leadDays} onChange={(event) => set({ leadDays: event.target.value })} />
        </label>
        <label className="maintenance-form-field">
          <span>Início previsto: dias antes do prazo</span>
          <input type="number" min="0" max="60" value={draft.startOffsetDays} onChange={(event) => set({ startOffsetDays: event.target.value })} />
        </label>
      </div>
    </div>
  )
}

type Collaborator = { userId: string; activity: string; dueDate: string }

function DemandForm() {
  const { demandId } = useParams()
  const { context, options } = useDemands()
  const user = useAuthenticatedUser()
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<DemandDetail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)

  const creatable = context.creatableSectorIds
  const ownSectors = context.createAnywhere ? options.sectors : options.sectors.filter((item) => creatable.includes(item.id))

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [originSectorId, setOriginSectorId] = useState(creatable[0] ?? ownSectors[0]?.id ?? '')
  const [responsibleSectorId, setResponsibleSectorId] = useState(creatable[0] ?? ownSectors[0]?.id ?? '')
  const [followUpManagerId, setFollowUpManagerId] = useState('')
  const [requesterId, setRequesterId] = useState(user?.id ?? '')
  const [responsibleId, setResponsibleId] = useState('')
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [collaboratorSectorIds, setCollaboratorSectorIds] = useState<string[]>([])
  const [startDate, setStartDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [priority, setPriority] = useState('media')
  const [status, setStatus] = useState<DemandStatus>('nao_iniciada')
  const [waitingFor, setWaitingFor] = useState('')
  const [suspensionReason, setSuspensionReason] = useState('')
  const [resumeDate, setResumeDate] = useState('')
  const [restricted, setRestricted] = useState(false)
  const [authorizedUserIds, setAuthorizedUserIds] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [references, setReferences] = useState('')
  const [reminderDays, setReminderDays] = useState('')
  const [repeat, setRepeat] = useState(false)
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(emptyRecurrence)
  const [files, setFiles] = useState<File[]>([])
  const [scope, setScope] = useState<'this' | 'future'>('this')

  const editing = Boolean(demandId)
  const draftMode = !editing || loaded?.demand.draft === true

  useEffect(() => {
    if (!demandId) return
    let active = true
    fetchDemand(demandId)
      .then((data) => {
        if (!active) return
        const { demand } = data
        setLoaded(data)
        setTitle(demand.title)
        setDescription(demand.description ?? '')
        setCategoryId(demand.categoryId ?? '')
        setOriginSectorId(demand.originSectorId ?? '')
        setResponsibleSectorId(demand.responsibleSectorId ?? '')
        setRequesterId(demand.requesterId ?? '')
        setResponsibleId(demand.responsibleId ?? '')
        setFollowUpManagerId(demand.followUpManagerId ?? '')
        setStartDate(demand.startDate ?? '')
        setDueDate(demand.dueDate ?? '')
        setPriority(demand.priority)
        setRestricted(demand.restricted)
        setNotes(demand.notes ?? '')
        setReferences(demand.references ?? '')
        setReminderDays(demand.reminderDays === null ? '' : String(demand.reminderDays))
        setCollaborators(
          data.participants
            .filter((item) => item.kind === 'colaborador')
            .map((item) => ({ userId: item.userId, activity: item.activity ?? '', dueDate: item.dueDate ?? '' })),
        )
        setAuthorizedUserIds(data.participants.filter((item) => item.kind === 'autorizado').map((item) => item.userId))
        setCollaboratorSectorIds(data.collaboratorSectors.map((item) => item.id))
        if (demand.draftRecurrence) {
          setRepeat(true)
          setRecurrence(recurrenceDraftFrom(demand.draftRecurrence))
        }
      })
      .catch((err: unknown) => {
        if (active) setLoadError(errorMessage(err, 'Não foi possível carregar a demanda.'))
      })
    return () => {
      active = false
    }
  }, [demandId])

  const sectorPeople = useMemo(
    () => options.people.filter((person) => person.sectorIds.includes(responsibleSectorId)),
    [options.people, responsibleSectorId],
  )

  const shareable = options.sectors.filter((item) => item.id !== responsibleSectorId)

  function commonBody() {
    return {
      title,
      description,
      categoryId: categoryId || null,
      originSectorId: originSectorId || null,
      responsibleSectorId: responsibleSectorId || null,
      followUpManagerId: followUpManagerId || null,
      startDate: startDate || null,
      dueDate: dueDate || null,
      priority,
      restricted,
      notes,
      references,
      reminderDays: reminderDays === '' ? null : Number(reminderDays),
    }
  }

  function collaborationBody() {
    return {
      collaborators: collaborators
        .filter((item) => item.userId)
        .map((item) => ({ userId: item.userId, activity: item.activity, dueDate: item.dueDate || null })),
      collaboratorSectorIds,
      authorizedUserIds: restricted ? authorizedUserIds : [],
    }
  }

  async function uploadFiles(id: string) {
    const failed: string[] = []
    for (const file of files) {
      try {
        await uploadDemandAttachment(id, file)
      } catch (err) {
        failed.push(`${file.name}: ${errorMessage(err, 'não enviado')}`)
      }
    }
    return failed
  }

  async function save(asDraft: boolean) {
    setSubmitError('')
    setBusy(true)
    try {
      if (!editing) {
        const created = await createDemand({
          ...commonBody(),
          ...collaborationBody(),
          draft: asDraft,
          requesterId: requesterId || null,
          responsibleId: responsibleId || null,
          status,
          waitingFor,
          suspensionReason,
          resumeDate,
          recurrence: repeat ? recurrencePayload(recurrence) : undefined,
        })
        const failed = await uploadFiles(created.id)
        navigate(`/demandas/${created.id}`, { state: failed.length ? { uploadErrors: failed } : undefined })
        return
      }
      const id = demandId as string
      if (draftMode) {
        await updateDemand(id, {
          ...commonBody(),
          ...collaborationBody(),
          requesterId: requesterId || null,
          responsibleId: responsibleId || null,
          recurrence: repeat ? recurrencePayload(recurrence) : null,
          version: loaded?.demand.version,
        })
        if (!asDraft) await publishDemand(id)
      } else {
        await updateDemand(id, { ...commonBody(), scope, version: loaded?.demand.version })
      }
      const failed = await uploadFiles(id)
      navigate(`/demandas/${id}`, { state: failed.length ? { uploadErrors: failed } : undefined })
    } catch (err) {
      setSubmitError(errorMessage(err, 'Não foi possível salvar a demanda.'))
      setBusy(false)
    }
  }

  if (loadError) return <Alert tone="error">{loadError}</Alert>
  if (editing && !loaded) return <Loading label="Carregando demanda..." />
  if (!editing && !context.canCreate) {
    return <Alert tone="warning">Você não tem autorização para cadastrar demandas em nenhum setor.</Alert>
  }
  if (loaded && !loaded.access.edit) return <Alert tone="error">Você não pode editar esta demanda.</Alert>

  function submit(event: FormEvent) {
    event.preventDefault()
    void save(false)
  }

  const isOccurrence = Boolean(loaded?.demand.recurring)
  // Fora o Diretor, a demanda é do próprio setor. Depois de cadastrada, só o Diretor muda o setor.
  // No rascunho, o setor já gravado continua na lista, mesmo que a pessoa tenha saído dele.
  const sectorChoices = draftMode
    ? options.sectors.filter(
        (item) =>
          ownSectors.includes(item) ||
          item.id === loaded?.demand.originSectorId ||
          item.id === loaded?.demand.responsibleSectorId,
      )
    : options.sectors
  const sectorLocked = Boolean(loaded) && !loaded?.access.transfer

  return (
    <form className="ui-card demand-form" onSubmit={submit}>
      <h2>{editing ? `Editar ${loaded?.demand.number}` : 'Nova demanda'}</h2>
      {submitError && <Alert tone="error">{submitError}</Alert>}

      <fieldset className="maintenance-form-group">
        <legend>Identificação</legend>
        <div className="demand-form-grid">
          <label className="maintenance-form-field demand-field-wide">
            <span>Título</span>
            <input required minLength={3} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="maintenance-form-field demand-field-wide">
            <span>Descrição detalhada</span>
            <textarea rows={4} maxLength={8000} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="maintenance-form-field">
            <span>Categoria</span>
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">Selecione</option>
              {options.categories.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
              {loaded?.demand.categoryId && !options.categories.some((item) => item.id === loaded.demand.categoryId) && (
                <option value={loaded.demand.categoryId}>{loaded.demand.category} (desativada)</option>
              )}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Setor de origem</span>
            <select value={originSectorId} disabled={sectorLocked} onChange={(event) => setOriginSectorId(event.target.value)}>
              <option value="">Selecione</option>
              {sectorChoices.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <label className="maintenance-form-field">
            <span>Setor responsável</span>
            <select
              value={responsibleSectorId}
              disabled={sectorLocked}
              onChange={(event) => {
                setResponsibleSectorId(event.target.value)
                setResponsibleId('')
              }}
            >
              <option value="">Selecione</option>
              {sectorChoices.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className="maintenance-form-group">
        <legend>Responsabilidade</legend>
        <div className="demand-form-grid">
          <label className="maintenance-form-field">
            <span>Diretor responsável pelo acompanhamento</span>
            <select value={followUpManagerId} onChange={(event) => setFollowUpManagerId(event.target.value)}>
              <option value="">Nenhum</option>
              {options.people
                .filter((person) => person.isManager || person.id === followUpManagerId)
                .map((person) => (
                  <option key={person.id} value={person.id}>{person.name}</option>
                ))}
            </select>
          </label>
          {draftMode ? (
            <>
              <label className="maintenance-form-field">
                <span>Solicitante</span>
                <select value={requesterId} onChange={(event) => setRequesterId(event.target.value)}>
                  {options.people.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                  {!options.people.some((item) => item.id === requesterId) && user && (
                    <option value={user.id}>{user.name}</option>
                  )}
                </select>
              </label>
              <label className="maintenance-form-field">
                <span>Responsável principal</span>
                <select value={responsibleId} onChange={(event) => setResponsibleId(event.target.value)}>
                  <option value="">Sem responsável, para o setor distribuir</option>
                  {sectorPeople.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p className="demand-muted demand-field-wide">
              Responsável, colaboradores e setores colaboradores são alterados na própria demanda.
            </p>
          )}
        </div>

        {draftMode && (
          <>
            <fieldset className="demand-checks demand-checks-inline">
              <legend>Setores colaboradores</legend>
              {shareable.length === 0 && <span className="demand-muted">Nenhum outro setor cadastrado.</span>}
              {shareable.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={collaboratorSectorIds.includes(item.id)}
                    onChange={(event) =>
                      setCollaboratorSectorIds((current) =>
                        event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {item.name}
                </label>
              ))}
            </fieldset>

            <div className="demand-collaborators">
              <h3>Colaboradores</h3>
              {collaborators.map((item, index) => (
                <div className="demand-collaborator-row" key={index}>
                  <label className="maintenance-form-field">
                    <span>Pessoa</span>
                    <select
                      required
                      value={item.userId}
                      onChange={(event) =>
                        setCollaborators((current) => current.map((row, position) => (position === index ? { ...row, userId: event.target.value } : row)))
                      }
                    >
                      <option value="">Selecione</option>
                      {options.people.map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="maintenance-form-field">
                    <span>Atividade</span>
                    <input
                      maxLength={500}
                      value={item.activity}
                      onChange={(event) =>
                        setCollaborators((current) => current.map((row, position) => (position === index ? { ...row, activity: event.target.value } : row)))
                      }
                    />
                  </label>
                  <label className="maintenance-form-field">
                    <span>Prazo da atividade</span>
                    <input
                      type="date"
                      value={item.dueDate}
                      onChange={(event) =>
                        setCollaborators((current) => current.map((row, position) => (position === index ? { ...row, dueDate: event.target.value } : row)))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="maintenance-secondary-button"
                    onClick={() => setCollaborators((current) => current.filter((_, position) => position !== index))}
                  >
                    Remover
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="maintenance-secondary-button"
                onClick={() => setCollaborators((current) => [...current, { userId: '', activity: '', dueDate: '' }])}
              >
                Adicionar colaborador
              </button>
            </div>
          </>
        )}
      </fieldset>

      <fieldset className="maintenance-form-group">
        <legend>Planejamento</legend>
        <div className="demand-form-grid">
          {!repeat && (
            <>
              <label className="maintenance-form-field">
                <span>Início previsto</span>
                <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
              </label>
              <label className="maintenance-form-field">
                <span>Prazo para conclusão</span>
                <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
              </label>
            </>
          )}
          <label className="maintenance-form-field">
            <span>Prioridade</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              {Object.entries(demandPriorityLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          {!editing && (
            <label className="maintenance-form-field">
              <span>Status inicial</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as DemandStatus)}>
                {initialStatuses.map((value) => (
                  <option key={value} value={value}>{demandStatusLabels[value]}</option>
                ))}
              </select>
            </label>
          )}
          <label className="maintenance-form-field">
            <span>Lembrete: dias antes do prazo</span>
            <input
              type="number"
              min="0"
              max="60"
              placeholder="Usa a preferência de cada pessoa"
              value={reminderDays}
              onChange={(event) => setReminderDays(event.target.value)}
            />
          </label>
          {!editing && status === 'aguardando_terceiros' && (
            <label className="maintenance-form-field">
              <span>Quem ou qual instituição</span>
              <input required maxLength={200} value={waitingFor} onChange={(event) => setWaitingFor(event.target.value)} />
            </label>
          )}
          {!editing && status === 'suspensa' && (
            <>
              <label className="maintenance-form-field">
                <span>Justificativa da suspensão</span>
                <input required minLength={3} value={suspensionReason} onChange={(event) => setSuspensionReason(event.target.value)} />
              </label>
              <label className="maintenance-form-field">
                <span>Previsão de retomada</span>
                <input type="date" value={resumeDate} onChange={(event) => setResumeDate(event.target.value)} />
              </label>
            </>
          )}
        </div>

        {draftMode && (
          <>
            <label className="demand-check">
              <input type="checkbox" checked={repeat} onChange={(event) => setRepeat(event.target.checked)} />
              Repetir a demanda
            </label>
            {repeat && <RecurrenceFields draft={recurrence} onChange={setRecurrence} />}
          </>
        )}

        {isOccurrence && !draftMode && (
          <fieldset className="demand-checks">
            <legend>Esta demanda é uma ocorrência recorrente. Aplicar a alteração a</legend>
            <label>
              <input type="radio" name="scope" checked={scope === 'this'} onChange={() => setScope('this')} />
              Somente esta ocorrência
            </label>
            <label>
              <input type="radio" name="scope" checked={scope === 'future'} onChange={() => setScope('future')} />
              Esta e as futuras (os prazos de cada uma não mudam)
            </label>
          </fieldset>
        )}
      </fieldset>

      <fieldset className="maintenance-form-group">
        <legend>Acesso</legend>
        <label className="demand-check">
          <input type="checkbox" checked={restricted} onChange={(event) => setRestricted(event.target.checked)} />
          Demanda restrita: no setor, só a chefia e quem está nominalmente envolvido podem ver
        </label>
        {restricted && (
          <>
            <p className="demand-muted">
              O servidor do setor só verá esta demanda se estiver envolvido nela ou constar da lista abaixo. Chefe do
              setor, Diretor e Administrador continuam vendo. Ela não aparece em pesquisas, painéis e relatórios de quem
              não está autorizado.
            </p>
            {draftMode ? (
              <fieldset className="demand-checks demand-checks-inline">
                <legend>Autorizados</legend>
                {options.people.map((person) => (
                  <label key={person.id}>
                    <input
                      type="checkbox"
                      checked={authorizedUserIds.includes(person.id)}
                      onChange={(event) =>
                        setAuthorizedUserIds((current) =>
                          event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id),
                        )
                      }
                    />
                    {person.name}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="demand-muted">Os autorizados são alterados na própria demanda.</p>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="maintenance-form-group">
        <legend>Documentação</legend>
        <div className="demand-form-grid">
          <label className="maintenance-form-field demand-field-wide">
            <span>Observações</span>
            <textarea rows={2} maxLength={4000} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label className="maintenance-form-field demand-field-wide">
            <span>Referências ou documentos relacionados</span>
            <textarea rows={2} maxLength={2000} value={references} onChange={(event) => setReferences(event.target.value)} />
          </label>
          <label className="maintenance-form-field demand-field-wide">
            <span>Anexos: PDF, imagens, Word, Excel ou texto</span>
            <input
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt"
              onChange={(event) => setFiles([...(event.target.files ?? [])])}
            />
          </label>
        </div>
      </fieldset>

      <div className="maintenance-form-actions">
        <button type="button" className="maintenance-secondary-button" onClick={() => navigate(-1)}>Voltar</button>
        {draftMode && (
          <button type="button" className="maintenance-secondary-button" disabled={busy} onClick={() => void save(true)}>
            Salvar como rascunho
          </button>
        )}
        <button type="submit" className="maintenance-primary-button" disabled={busy}>
          {busy ? 'Salvando...' : editing && !draftMode ? 'Salvar alterações' : 'Cadastrar demanda'}
        </button>
      </div>
    </form>
  )
}

export default DemandForm
