import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createRequest, errorMessage } from '../api/modulesApi'
import ConfiguredField from '../components/ConfiguredField'
import { customFieldsOf, isManagedFieldVisible, useCanActOnBehalf } from '../app/requestForm'
import { RequestField } from '../components/RequestFields'
import { useConfiguredForm } from '../app/useConfiguredForm'
import { privacyNotices } from '../app/privacyNotices'
import { useDuplicateCheck } from '../app/useDuplicateCheck'
import { useAuthenticatedUser } from '../auth/UserContext'
import DuplicateWarning from '../components/DuplicateWarning'
import FormNotices from '../components/FormNotices'
import { Alert } from '../components/ui/Feedback'
import PageHeader from '../components/ui/PageHeader'
import { uploadPendingFiles, warnFailedUploads } from '../app/formFiles'

type Passenger = {
  id: number
  name: string
  cpf: string
}

type TripType = 'one-way' | 'round-trip' | 'return-only'

const tripTypeByOption: Record<string, TripType> = {
  'Somente ida': 'one-way',
  'Ida e volta': 'round-trip',
  'Somente volta': 'return-only',
}

const apiTripType: Record<TripType, string> = {
  'one-way': 'somente_ida',
  'round-trip': 'ida_volta',
  'return-only': 'somente_volta',
}

const knownFields = [
  'requesterName',
  'requesterEmail',
  'requesterSector',
  'requesterFloor',
  'requesterRoom',
  'passengerName',
  'passengerCpf',
  'tripType',
  'outboundOrigin',
  'outboundDestination',
  'departureDate',
  'departureTime',
  'returnOrigin',
  'returnDestination',
  'returnDate',
  'returnTime',
  'baggage',
  'notes',
]

const outboundFields = ['outboundOrigin', 'outboundDestination', 'departureDate', 'departureTime']

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
  const navigate = useNavigate()
  const canActOnBehalf = useCanActOnBehalf()
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [tripType, setTripType] = useState<TripType>('one-way')
  const [passengers, setPassengers] = useState<Passenger[]>([
    { id: 1, name: '', cpf: '' },
  ])
  const [nextPassengerId, setNextPassengerId] = useState(2)
  const [departureDate, setDepartureDate] = useState('')
  const [departureTime, setDepartureTime] = useState('')
  const [returnDate, setReturnDate] = useState('')
  const [returnTime, setReturnTime] = useState('')
  const returnTimeRef = useRef<HTMLInputElement>(null)
  const duplicate = useDuplicateCheck('flights')
  const isStaff = useAuthenticatedUser()?.permissions.includes('flights:update') ?? false
  const visibleFields = fields.filter((field) => isManagedFieldVisible(field, values, isStaff))

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
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

    setSubmitError('')
    if (!form.reportValidity()) return

    await send()
  }

  async function send(acknowledged = duplicate.acknowledged) {
    const outbound = {
      origem: values.outboundOrigin,
      destino: values.outboundDestination,
      data: departureDate,
      horario: departureTime,
    }
    const inbound = {
      origem: values.returnOrigin,
      destino: values.returnDestination,
      data: returnDate,
      horario: returnTime,
    }

    setSubmitting(true)
    try {
      const body = {
        setorId: values.requesterSector || undefined,
        andarId: values.requesterFloor,
        sala: values.requesterRoom,
        tipoViagem: apiTripType[tripType],
        ida: tripType === 'return-only' ? undefined : outbound,
        volta: tripType === 'one-way' ? undefined : inbound,
        bagagem: values.baggage,
        observacoes: values.notes,
        passageiros: passengers.map((passenger) => ({
          nome: passenger.name,
          cpf: passenger.cpf,
        })),
        avisoPrivacidade: privacyNotices.flights.version,
        customFields: customFieldsOf(visibleFields, values, knownFields),
      }
      // A conferência de duplicidade não recebe passageiros nem CPF.
      const probe: Partial<typeof body> = { ...body }
      delete probe.passageiros
      if (!acknowledged && !(await duplicate.shouldProceed(probe))) {
        setSubmitting(false)
        return
      }
      const created = await createRequest('flights', { ...body, duplicidadeAvisada: acknowledged })
      warnFailedUploads(await uploadPendingFiles('service_request', created.id, body.customFields, Object.fromEntries(visibleFields.map((field) => [field.id, field.label]))))
      navigate(`/passagens-aereas/${created.id}`)
    } catch (err) {
      setSubmitError(errorMessage(err, 'Não foi possível enviar a solicitação.'))
      setSubmitting(false)
    }
  }

  return (
    <div className="maintenance-page maintenance-request-page air-travel-request-page">
      <PageHeader title="Nova solicitação de passagens aéreas" description="Informe os dados do solicitante, dos passageiros e dos trechos." />


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
          onSubmit={(event) => void handleSubmit(event)}
        >
          {error && (
            <div className="settings-storage-error" role="alert">
              {error} Os campos padrão estão sendo exibidos.
            </div>
          )}
          <div className="maintenance-request-fields">
            {visibleFields
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

                if (field.id.startsWith('return') && tripType === 'one-way') {
                  return null
                }
                if (outboundFields.includes(field.id) && tripType === 'return-only') {
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
                            checked={tripType === tripTypeByOption[option]}
                            onChange={() => setTripType(tripTypeByOption[option])}
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

                return (
                  <RequestField
                    key={field.id}
                    field={field}
                    values={values}
                    onChange={(id, value) =>
                      setValues((current) => ({ ...current, [id]: value }))
                    }
                    canActOnBehalf={canActOnBehalf}
                    identityFields={{ requesterName: 'name', requesterEmail: 'email' }}
                    sectorField="requesterSector"
                  />
                )
              })}
          </div>

          <FormNotices module="flights" />

          <DuplicateWarning
            module="flights"
            duplicates={duplicate.duplicates}
            onConfirm={() => {
              duplicate.acknowledge()
              void send(true)
            }}
            onDismiss={duplicate.dismiss}
          />

          <div className="maintenance-form-actions">
            <Link
              className="maintenance-secondary-button"
              to="/passagens-aereas"
            >
              Voltar
            </Link>
            <div className="maintenance-submit-action">
              <button className="maintenance-primary-button" type="submit" disabled={submitting}>
                {submitting ? 'Enviando...' : 'Enviar solicitação'}
              </button>
              {submitError && (
                <Alert tone="error">{submitError}</Alert>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
  )
}

export default AirTravelRequestPage
