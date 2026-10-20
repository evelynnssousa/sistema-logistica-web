import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import ConfiguredField from '../components/ConfiguredField'
import { useConfiguredForm } from '../app/useConfiguredForm'

type Passenger = {
  id: number
  name: string
  cpf: string
}

const maxPassengers = 10
function formatCpf(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 11)
  return digits
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1-$2')
}

function isValidCpf(value: string) {
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false

  const calculateDigit = (length: number) => {
    const sum = digits
      .slice(0, length)
      .split('')
      .reduce(
        (total, digit, index) => total + Number(digit) * (length + 1 - index),
        0,
      )
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  return (
    calculateDigit(9) === Number(digits[9]) &&
    calculateDigit(10) === Number(digits[10])
  )
}

function dateTimeValue(date: string, time: string) {
  if (!date || !time) return null
  const value = new Date(`${date}T${time}`)
  return Number.isNaN(value.getTime()) ? null : value.getTime()
}

function AirTravelRequestPage() {
  const { fields, error } = useConfiguredForm('airTravel')
  const [tripType, setTripType] = useState<'one-way' | 'round-trip'>('one-way')
  const [passengers, setPassengers] = useState<Passenger[]>([
    { id: 1, name: '', cpf: '' },
  ])
  const [nextPassengerId, setNextPassengerId] = useState(2)
  const [departureDate, setDepartureDate] = useState('')
  const [departureTime, setDepartureTime] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [returnTime, setReturnTime] = useState('')
  const [submissionNotice, setSubmissionNotice] = useState('')
  const returnTimeRef = useRef<HTMLInputElement>(null)

  function updatePassenger(
    id: number,
    field: 'name' | 'cpf',
    value: string,
  ) {
    setPassengers((current) =>
      current.map((passenger) =>
        passenger.id === id ? { ...passenger, [field]: value } : passenger,
      ),
    )
  }

  function addPassenger() {
    setPassengers((current) => {
      if (current.length >= maxPassengers) return current
      return [
        ...current,
        { id: nextPassengerId, name: '', cpf: '' },
      ]
    })
    setNextPassengerId((id) => id + 1)
  }

  function removePassenger(id: number) {
    setPassengers((current) =>
      current.length > 1
        ? current.filter((passenger) => passenger.id !== id)
        : current,
    )
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const cpfInputs = Array.from(
      form.querySelectorAll<HTMLInputElement>('input[name="passengerCpf"]'),
    )
    cpfInputs.forEach((input) => {
      input.setCustomValidity(
        input.value && !isValidCpf(input.value)
          ? 'Informe um CPF válido.'
          : '',
      )
    })

    if (tripType === 'round-trip') {
      const outbound = dateTimeValue(departureDate, departureTime)
      const inbound = dateTimeValue(returnDate, returnTime)
      returnTimeRef.current?.setCustomValidity(
        outbound !== null && inbound !== null && inbound < outbound
          ? 'A data e o horário de volta não podem ser anteriores à ida.'
          : '',
      )
    }

    if (!form.reportValidity()) {
      setSubmissionNotice('')
      return
    }

    setSubmissionNotice(
      'O envio real ainda não está implementado. Nenhum dado foi enviado ou registrado.',
    )
  }

  return (
    <div className="maintenance-page maintenance-request-page air-travel-request-page">
      <section className="maintenance-heading">
        <div>
          <div className="eyebrow">JUCESP · GESTÃO OPERACIONAL</div>
          <h1>Nova solicitação de passagens aéreas</h1>
          <p>Informe os dados do solicitante, dos passageiros e dos trechos.</p>
        </div>
      </section>

      <section
        className="maintenance-request-card"
        aria-labelledby="air-travel-request-details"
      >
        <div className="maintenance-request-section-heading">
          <h2 id="air-travel-request-details">Dados da solicitação</h2>
          <p>
            Os campos marcados com <span aria-hidden="true">*</span> são
            obrigatórios.
          </p>
        </div>

        <form
          noValidate
          onSubmit={handleSubmit}
          onChange={() => setSubmissionNotice('')}
        >
          {error && (
            <div className="settings-storage-error" role="alert">
              {error} Os campos padrão estão sendo exibidos.
            </div>
          )}
          <div className="maintenance-request-fields">
            {fields
              .filter((field) => field.active)
              .map((field) => {
                if (field.id === 'passengerCpf') return null

                if (field.id === 'passengerName') {
                  const passengerFields = fields.filter(
                    (item) =>
                      item.active &&
                      (item.id === 'passengerName' ||
                        item.id === 'passengerCpf'),
                  )
                  return (
                    <fieldset
                      className="maintenance-form-group passenger-list"
                      key={field.id}
                    >
                      <legend>Passageiros</legend>
                      {passengers.map((passenger, index) => (
                        <div className="air-travel-passenger" key={passenger.id}>
                          <div className="air-travel-passenger-heading">
                            <h3>Passageiro {index + 1}</h3>
                            {passengers.length > 1 && (
                              <button
                                className="air-travel-remove-passenger"
                                type="button"
                                onClick={() => removePassenger(passenger.id)}
                                aria-label={`Remover passageiro ${index + 1}`}
                              >
                                Remover
                              </button>
                            )}
                          </div>
                          {passengerFields.map((passengerField) =>
                            passengerField.id === 'passengerName' ? (
                              <ConfiguredField
                                key={passengerField.id}
                                field={passengerField}
                                value={passenger.name}
                                onValueChange={(value) =>
                                  updatePassenger(passenger.id, 'name', value)
                                }
                              />
                            ) : (
                              <label
                                className="maintenance-form-field"
                                key={passengerField.id}
                              >
                                <span>
                                  {passengerField.label}
                                  {passengerField.required && (
                                    <>
                                      {' '}
                                      <span className="required-marker">*</span>
                                    </>
                                  )}
                                </span>
                                {passengerField.description && (
                                  <small>{passengerField.description}</small>
                                )}
                                <input
                                  type="text"
                                  name="passengerCpf"
                                  inputMode="numeric"
                                  autoComplete="off"
                                  maxLength={14}
                                  placeholder="000.000.000-00"
                                  required={passengerField.required}
                                  value={passenger.cpf}
                                  onChange={(event) => {
                                    const formatted = formatCpf(event.target.value)
                                    event.target.setCustomValidity(
                                      formatted && !isValidCpf(formatted)
                                        ? 'Informe um CPF válido.'
                                        : '',
                                    )
                                    updatePassenger(
                                      passenger.id,
                                      'cpf',
                                      formatted,
                                    )
                                  }}
                                />
                              </label>
                            ),
                          )}
                        </div>
                      ))}
                      <div className="air-travel-passenger-controls">
                        <button
                          className="air-travel-add-passenger"
                          type="button"
                          onClick={addPassenger}
                          disabled={passengers.length >= maxPassengers}
                          aria-describedby="air-travel-passenger-limit"
                        >
                          Adicionar passageiro
                        </button>
                        <span id="air-travel-passenger-limit">
                          {passengers.length} de {maxPassengers} passageiros
                        </span>
                      </div>
                    </fieldset>
                  )
                }

                if (
                  field.id.startsWith('return') &&
                  tripType !== 'round-trip'
                ) {
                  return null
                }

                if (field.id === 'tripType') {
                  return (
                    <div className="air-travel-trip-type" key={field.id}>
                      <span id="air-travel-type-label">
                        {field.label}
                        {field.required && (
                          <>
                            {' '}
                            <span className="required-marker">*</span>
                          </>
                        )}
                      </span>
                      {field.options.map((option) => (
                        <label key={option}>
                          <input
                            type="radio"
                            name="tripType"
                            value={option}
                            required={field.required}
                            checked={tripType === (option === 'Somente ida' ? 'one-way' : 'round-trip')}
                            onChange={() =>
                              setTripType(
                                option === 'Somente ida'
                                  ? 'one-way'
                                  : 'round-trip',
                              )
                            }
                          />
                          {option}
                        </label>
                      ))}
                      {field.description && <small>{field.description}</small>}
                    </div>
                  )
                }

                if (field.id === 'returnTime') {
                  return (
                    <label className="maintenance-form-field" key={field.id}>
                      <span>
                        {field.label}
                        {field.required && (
                          <>
                            {' '}
                            <span className="required-marker">*</span>
                          </>
                        )}
                      </span>
                      {field.description && <small>{field.description}</small>}
                      <input
                        ref={returnTimeRef}
                        type="time"
                        name={field.id}
                        required={field.required}
                        value={returnTime}
                        onChange={(event) => setReturnTime(event.target.value)}
                      />
                    </label>
                  )
                }

                if (field.id === 'returnDate') {
                  return (
                    <label className="maintenance-form-field" key={field.id}>
                      <span>
                        {field.label}
                        {field.required && (
                          <>
                            {' '}
                            <span className="required-marker">*</span>
                          </>
                        )}
                      </span>
                      {field.description && <small>{field.description}</small>}
                      <input
                        type="date"
                        name={field.id}
                        required={field.required}
                        min={departureDate || undefined}
                        value={returnDate}
                        onChange={(event) => setReturnDate(event.target.value)}
                      />
                    </label>
                  )
                }

                if (
                  field.id === 'departureDate' ||
                  field.id === 'departureTime'
                ) {
                  const value =
                    field.id === 'departureDate'
                      ? departureDate
                      : departureTime
                  const onValueChange =
                    field.id === 'departureDate'
                      ? setDepartureDate
                      : setDepartureTime
                  return (
                    <ConfiguredField
                      key={field.id}
                      field={field}
                      value={value}
                      onValueChange={onValueChange}
                    />
                  )
                }

                return <ConfiguredField key={field.id} field={field} />
              })}
          </div>

          <div className="maintenance-form-actions">
            <Link
              className="maintenance-secondary-button"
              to="/passagens-aereas"
            >
              Voltar
            </Link>
            <div className="maintenance-submit-action">
              <button className="maintenance-primary-button" type="submit">
                Enviar solicitação
              </button>
              <span>
                O envio real ainda não está implementado; nenhum dado será
                registrado.
              </span>
              {submissionNotice && (
                <span className="air-travel-submit-notice" role="status">
                  {submissionNotice}
                </span>
              )}
            </div>
          </div>

          <p className="air-travel-data-consent">
            Ao clicar em enviar, você concorda com o armazenamento de seus dados
            em nosso sistema
          </p>
        </form>
      </section>
    </div>
  )
}

export default AirTravelRequestPage
