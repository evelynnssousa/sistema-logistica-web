import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeError } from './logger.js'

test('resume erros sem incluir a mensagem original', () => {
  const summary = describeError(
    new Error('INSERT falhou para fulano@example.gov.br com senha segredo'),
  )

  assert.deepEqual(summary, { errorName: 'Error', errorCode: null })
  assert.doesNotMatch(JSON.stringify(summary), /fulano|segredo/)
})

test('aproveita o código do banco guardado em cause', () => {
  const error = new Error('Falha de persistência.', {
    cause: Object.assign(new Error('relation does not exist'), {
      code: '42P01',
    }),
  })

  assert.deepEqual(describeError(error), {
    errorName: 'Error',
    errorCode: '42P01',
  })
})

test('descarta códigos que não têm formato seguro', () => {
  const error = Object.assign(new Error('falha'), {
    code: 'senha com espaços: segredo',
  })

  assert.equal(describeError(error).errorCode, null)
  assert.deepEqual(describeError('texto solto'), {
    errorName: 'UnknownError',
    errorCode: null,
  })
})
