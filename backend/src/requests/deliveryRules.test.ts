import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCalendarDate, renderEmail, renderNotification, renderSubject } from '../integrations/catalog.js'
import {
  deliveryStatusOf,
  readEffectiveDeliveryDate,
  readRequesterEmail,
  todayInSaoPaulo,
  validateDeliveryForecast,
} from './deliveryRules.js'
import { RequestValidationError } from './validation.js'

// 02:00 em UTC ainda é o dia anterior em São Paulo: é aqui que um erro de fuso apareceria.
const now = new Date('2030-03-10T02:00:00.000Z')

test('o dia de referência é o de São Paulo, não o do servidor', () => {
  assert.equal(todayInSaoPaulo(now), '2030-03-09')
})

test('previsão: só um dia válido, de hoje em diante', () => {
  assert.equal(validateDeliveryForecast({ date: '2030-03-09' }, now).date, '2030-03-09')
  for (const date of ['2030-03-08', '2030-02-31', '10/03/2030', '2030-03-10T10:00', '', null, 20300310]) {
    assert.throws(() => validateDeliveryForecast({ date }, now), RequestValidationError, String(date))
  }
})

test('entrega efetiva: não aceita o futuro, e o dia passado não muda com o fuso', () => {
  assert.equal(readEffectiveDeliveryDate(undefined, now), null)
  assert.equal(readEffectiveDeliveryDate('2030-03-09', now), now)
  assert.throws(() => readEffectiveDeliveryDate('2030-03-10', now), RequestValidationError)
  assert.throws(() => readEffectiveDeliveryDate('ontem', now), RequestValidationError)

  const past = readEffectiveDeliveryDate('2030-03-01', now)
  assert.ok(past)
  assert.equal(todayInSaoPaulo(past), '2030-03-01')
})

test('e-mail do solicitante: opcional, válido e, com a lista oficial, institucional', () => {
  const environment = { INSTITUTIONAL_EMAIL_DOMAINS: 'orgao.sp.gov.br' } as unknown as NodeJS.ProcessEnv
  assert.equal(readRequesterEmail('', environment), null)
  assert.equal(readRequesterEmail(' Pessoa@Orgao.sp.gov.br ', environment), 'pessoa@orgao.sp.gov.br')
  assert.throws(() => readRequesterEmail('sem-arroba', environment), RequestValidationError)
  assert.throws(() => readRequesterEmail('pessoa@gmail.com', environment), RequestValidationError)
})

test('situação da entrega: uma previsão nunca conclui a entrega', () => {
  assert.equal(deliveryStatusOf({ status: 'pendente', forecastRevision: 0 }), 'aguardando_entrega')
  assert.equal(deliveryStatusOf({ status: 'atendido', forecastRevision: 1 }), 'aguardando_entrega')
  assert.equal(deliveryStatusOf({ status: 'atendido', forecastRevision: 2 }), 'entrega_reagendada')
  assert.equal(deliveryStatusOf({ status: 'entregue', forecastRevision: 0 }), 'entregue')
  assert.equal(deliveryStatusOf({ status: 'entregue', forecastRevision: 3 }), 'entregue')
  assert.equal(deliveryStatusOf({ status: 'cancelado', forecastRevision: 2 }), null)
  assert.equal(deliveryStatusOf({ status: 'rejeitado', forecastRevision: 1 }), null)
})

test('comunicação da previsão segue o modelo institucional', () => {
  const context = { module: 'warehouse', protocol: 'ALM-2030-00007', forecastDate: '2030-03-15' } as const
  assert.equal(formatCalendarDate('2030-03-15'), '15/03/2030')
  assert.equal(
    renderSubject('warehouse_forecast_set', context),
    'Previsão de entrega de materiais — ALM-2030-00007',
  )

  const { text, html } = renderEmail('warehouse_forecast_set', context, null)
  for (const line of [
    'Prezado(a),',
    'Informamos que os materiais relacionados à sua solicitação possuem previsão de entrega para 15/03/2030.',
    'Em caso de alteração da previsão, você será informado(a).',
    'Atenciosamente,',
    'Equipe de Serviços de Logística e Manutenção — SLM',
    'JUCESP',
    'Protocolo: ALM-2030-00007',
  ]) {
    assert.ok(text.includes(line), line)
  }
  assert.ok(html.includes('15/03/2030'))
  assert.equal(renderNotification('warehouse_forecast_set', context).message, 'Previsão de entrega para 15/03/2030.')
})

test('a alteração informa as duas datas e não tem campo para a justificativa', () => {
  const { text, subject } = renderEmail(
    'warehouse_forecast_changed',
    {
      module: 'warehouse',
      protocol: '12',
      forecastDate: '2030-03-20',
      previousForecastDate: '2030-03-15',
    },
    null,
  )
  assert.equal(subject, 'Alteração da previsão de entrega de materiais — #12')
  assert.ok(text.includes('foi alterada para 20/03/2030'))
  assert.ok(text.includes('Previsão anterior: 15/03/2030'))
})
