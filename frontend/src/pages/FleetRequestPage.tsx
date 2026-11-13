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
  'requester',
  'sector',
  'floor',
  'origin',
  'destination',
  'departureAt',
  'returnAt',
  'serviceRequested',
  'vehicle',
  'passengerNames',
  'notes',
]

function FleetRequestPage() {
  const { fields, error } = useConfiguredForm('fleet')
  const navigate = useNavigate()
  const canActOnBehalf = useCanActOnBehalf()
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const duplicate = useDuplicateCheck('fleet')
  const isStaff = useAuthenticatedUser()?.permissions.includes('fleet:update') ?? false
  const visibleFields = fields.filter((field) => isManagedFieldVisible(field, values, isStaff))

  function buildBody() {
    return {
        setorId: values.sector || undefined,
        andarId: values.floor || undefined,
        origem: values.origin,
        destino: values.destination,
        dataHora: fromLocalInput(values.departureAt ?? ''),
        dataHoraRetorno: fromLocalInput(values.returnAt ?? ''),
        finalidade: values.serviceRequested,
        veiculo: values.vehicle,
        // Um nome por linha. Frota não coleta CPF.
        passageiros: (values.passengerNames ?? '')
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean)
          .map((nome) => ({ nome })),
        observacoes: values.notes,
        customFields: customFieldsOf(visibleFields, values, knownFields),
        avisoPrivacidade: privacyNotices.fleet.version,
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
      const created = await createRequest('fleet', { ...body, duplicidadeAvisada: acknowledged })
      warnFailedUploads(await uploadPendingFiles('service_request', created.id, body.customFields, Object.fromEntries(visibleFields.map((field) => [field.id, field.label]))))
      navigate(`/frota/${created.id}`)
    } catch (err) {
      setSubmitError(errorMessage(err, 'Não foi possível enviar a solicitação.'))
      setSubmitting(false)
    }
  }

  return (
    <div className="maintenance-page maintenance-request-page fleet-request-page">
      <PageHeader title="Nova solicitação de frota" description="Informe origem, destino, data e demais dados do deslocamento." />


      <section className="maintenance-request-card" aria-labelledby="fleet-request-details">
        <div className="maintenance-request-section-heading">
          <h2 id="fleet-request-details">Dados da solicitação</h2>
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
                  heading={sectionTitle('fleet', field, visibleFields[index - 1])}
                  field={field}
                  values={values}
                  onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
                  canActOnBehalf={canActOnBehalf}
                  identityFields={{ requester: 'name' }}
                  sectorField="sector"
                />
              ))}
          </div>

          <FormNotices module="fleet" />

          <DuplicateWarning
            module="fleet"
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
            <Link className="maintenance-secondary-button" to="/frota">
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

export default FleetRequestPage
