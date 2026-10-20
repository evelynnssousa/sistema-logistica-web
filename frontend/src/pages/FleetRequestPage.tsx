import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import ConfiguredField from '../components/ConfiguredField'
import { useConfiguredForm } from '../app/useConfiguredForm'

function FleetRequestPage() {
  const [submissionNotice, setSubmissionNotice] = useState('')
  const { fields, error } = useConfiguredForm('fleet')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmissionNotice(
      'O envio ainda não está disponível. Nenhum dado foi enviado ou registrado.',
    )
  }

  return (
    <div className="maintenance-page maintenance-request-page fleet-request-page">
      <section className="maintenance-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Nova solicitação de frota</h1>
          <p>Informe os dados básicos da solicitação relacionada à frota.</p>
        </div>
      </section>

      <section
        className="maintenance-request-card"
        aria-labelledby="fleet-request-details"
      >
        <div className="maintenance-request-section-heading">
          <h2 id="fleet-request-details">Dados da solicitação</h2>
          <p>
            A obrigatoriedade ainda precisa ser confirmada; nesta versão
            visual, os campos marcados com <span aria-hidden="true">*</span>{' '}
            são exigidos para validação.
          </p>
        </div>

        {error && (
          <div className="settings-storage-error" role="alert">
            {error} Os campos padrão estão sendo exibidos.
          </div>
        )}

        <form onSubmit={handleSubmit} onChange={() => setSubmissionNotice('')}>
          <div className="maintenance-request-fields">
            {fields
              .filter((field) => field.active)
              .map((field) => (
                <ConfiguredField key={field.id} field={field} />
              ))}
          </div>

          <div className="maintenance-form-actions">
            <Link className="maintenance-secondary-button" to="/frota">
              Voltar
            </Link>
            <div className="maintenance-submit-action">
              <button className="maintenance-primary-button" type="submit">
                Enviar solicitação
              </button>
              <span>
                A integração ainda não está disponível; o envio não registra
                solicitações.
              </span>
              {submissionNotice && (
                <span
                  className="fleet-request-notice"
                  role="status"
                  aria-live="polite"
                >
                  {submissionNotice}
                </span>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
  )
}

export default FleetRequestPage
