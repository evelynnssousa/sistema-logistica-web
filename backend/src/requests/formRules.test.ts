import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentFieldForms, defaultForms, validateCustomValues, validateFormContent } from './formRules.js'
import type { ManagedForm } from './formRules.js'

// Campo do tipo "Anexo" (13/11/2026): aceito só onde há lista de anexos; o valor é o nome do arquivo.

function withAttachment(form: ManagedForm, required = true) {
  const content = defaultForms[form]
  return {
    sections: content.sections,
    fields: [
      ...content.fields,
      { id: 'custom-comprovante', label: 'Comprovante', type: 'attachment', required, active: true, section: content.sections[0].id, options: [] },
    ],
  }
}

test('anexo: aceito nos formulários das solicitações e pedidos, recusado nos demais', () => {
  for (const form of attachmentFieldForms) {
    const content = validateFormContent(form, withAttachment(form))
    assert.equal(content.fields.find((field) => field.id === 'custom-comprovante')?.type, 'attachment', form)
  }
  for (const form of ['demand', 'vehicle', 'registration'] as ManagedForm[]) {
    assert.throws(() => validateFormContent(form, withAttachment(form)), /tipo Anexo/, form)
  }
})

test('anexo: obrigatório exige o arquivo, e o valor é só um nome de arquivo', () => {
  const content = validateFormContent('maintenance', withAttachment('maintenance'))
  assert.throws(() => validateCustomValues(content, {}), /Preencha o campo "Comprovante"/)
  assert.deepEqual(validateCustomValues(content, { 'custom-comprovante': ' orcamento.pdf ' }).values, { 'custom-comprovante': 'orcamento.pdf' })
  assert.throws(() => validateCustomValues(content, { 'custom-comprovante': '../segredo.pdf' }), /nome de arquivo inválido/)
  assert.throws(() => validateCustomValues(content, { 'custom-comprovante': `${'a'.repeat(181)}.pdf` }), /nome de arquivo inválido/)

  const optional = validateFormContent('warehouseRequest', withAttachment('warehouseRequest', false))
  assert.deepEqual(validateCustomValues(optional, {}).values, {})
})
