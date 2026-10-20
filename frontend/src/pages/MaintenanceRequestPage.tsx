import { Link } from 'react-router-dom'
import ConfiguredField from '../components/ConfiguredField'
import { useConfiguredForm } from '../app/useConfiguredForm'

function MaintenanceRequestPage() {
  const { fields, error } = useConfiguredForm('maintenance')

  return (
    <div className="maintenance-page maintenance-request-page">
      <section className="maintenance-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Nova solicitação de manutenção</h1>
          <p>Preencha os dados para registrar uma solicitação de serviço.</p>
        </div>
      </section>

      <section
        className="maintenance-request-card"
        aria-labelledby="maintenance-request-details"
      >
        <div className="maintenance-request-section-heading">
          <h2 id="maintenance-request-details">Dados da solicitação</h2>
          <p>
            Os campos marcados com <span aria-hidden="true">*</span> são
            obrigatórios.
          </p>
        </div>

        {error && (
          <div className="settings-storage-error" role="alert">
            {error} Os campos padrão estão sendo exibidos.
          </div>
        )}

        <div className="maintenance-request-fields">
          {fields
            .filter((field) => field.active)
            .map((field) => (
              <ConfiguredField key={field.id} field={field} />
            ))}
        </div>

        <div className="maintenance-form-actions">
          <Link className="maintenance-secondary-button" to="/manutencao">
            Voltar
          </Link>
          <div className="maintenance-submit-action">
            <button
              className="maintenance-primary-button"
              type="button"
              disabled
            >
              Enviar solicitação
            </button>
            <span>
              O envio estará disponível após a implementação da integração.
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}

export default MaintenanceRequestPage
