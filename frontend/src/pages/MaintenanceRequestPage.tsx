import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createRequest, errorMessage, fromLocalInput } from '../api/modulesApi'
import { useConfiguredForm } from '../app/useConfiguredForm'
import { privacyNotices } from '../app/privacyNotices'
import { useDuplicateCheck } from '../app/useDuplicateCheck'
import { useAuthenticatedUser } from '../auth/UserContext'
import DuplicateWarning from '../components/DuplicateWarning'
import FormNotices from '../components/FormNotices'
import { Alert } from '../components/ui/Feedback'
import PageHeader from '../components/ui/PageHeader'
import { sectionTitle } from '../app/formDefinitions'
import { customFieldsOf, isManagedFieldVisible, useCanActOnBehalf } from '../app/requestForm'
import { RequestField } from '../components/RequestFields'
import { uploadPendingFiles, warnFailedUploads } from '../app/formFiles'

const knownFields = [
  'solicitante',
  'email',
  'setor',
  'andar',
  'sala',
  'tipoSolicitacao',
  'descricao',
  'localServico',
  'dataPreferencial',
  'observacoes',
]

function MaintenanceRequestPage() {
  const { fields, error } = useConfiguredForm('maintenance')
  const navigate = useNavigate()
  const canActOnBehalf = useCanActOnBehalf()
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const duplicate = useDuplicateCheck('maintenance')
  const isStaff = useAuthenticatedUser()?.permissions.includes('maintenance:update') ?? false
  const visibleFields = fields.filter((field) => isManagedFieldVisible(field, values, isStaff))

  function buildBody() {
    return {
        setorId: values.setor || undefined,
        andarId: values.andar,
        tipoServicoId: values.tipoSolicitacao,
        sala: values.sala,
        localServico: values.localServico,
        descricao: values.descricao,
        dataPreferencial: fromLocalInput(values.dataPreferencial ?? ''),
        observacoes: values.observacoes,
        customFields: customFieldsOf(visibleFields, values, knownFields),
        avisoPrivacidade: privacyNotices.maintenance.version,
      }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await send()
  }

  async function send(acknowledged = duplicate.acknowledged) {
    setSubmitError('')
    setSubmitting(true)
    try {
      const body = buildBody()
      if (!acknowledged && !(await duplicate.shouldProceed(body))) {
        setSubmitting(false)
        return
      }
      const created = await createRequest('maintenance', { ...body, duplicidadeAvisada: acknowledged })
      warnFailedUploads(await uploadPendingFiles('service_request', created.id, body.customFields, Object.fromEntries(visibleFields.map((field) => [field.id, field.label]))))
      navigate(`/manutencao/${created.id}`)
    } catch (err) {
      setSubmitError(errorMessage(err, 'Não foi possível enviar a solicitação.'))
      setSubmitting(false)
    }
  }

  return (
    <div className="maintenance-page maintenance-request-page">
      <PageHeader title="Nova solicitação de manutenção" description="Preencha os dados para registrar uma solicitação de serviço." />


      <section className="maintenance-request-card" aria-labelledby="maintenance-request-details">
        <div className="maintenance-request-section-heading">
          <h2 id="maintenance-request-details">Dados da solicitação</h2>
          <p>
            Os campos marcados com <span aria-hidden="true">*</span> são obrigatórios.
          </p>
        </div>

        {error && (
          <div className="settings-storage-error" role="alert">
            {error} Os campos padrão estão sendo exibidos.
          </div>
        )}

        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="maintenance-request-fields">
            {visibleFields
              .map((field, index) => (
                <RequestField
                  key={field.id}
                  heading={sectionTitle('maintenance', field, visibleFields[index - 1])}
                  field={field}
                  values={values}
                  onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
                  canActOnBehalf={canActOnBehalf}
                  identityFields={{ solicitante: 'name', email: 'email' }}
                  sectorField="setor"
                />
              ))}
          </div>

          <FormNotices module="maintenance" />

          <DuplicateWarning
            module="maintenance"
            duplicates={duplicate.duplicates}
            onConfirm={() => {
              duplicate.acknowledge()
              void send(true)
            }}
            onDismiss={duplicate.dismiss}
          />

          {submitError && (
            <Alert tone="error">{submitError}</Alert>
          )}

          <div className="maintenance-form-actions">
            <Link className="maintenance-secondary-button" to="/manutencao">
              Voltar
            </Link>
            <div className="maintenance-submit-action">
              <button className="maintenance-primary-button" type="submit" disabled={submitting}>
                {submitting ? 'Enviando...' : 'Enviar solicitação'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  )
}

export default MaintenanceRequestPage
