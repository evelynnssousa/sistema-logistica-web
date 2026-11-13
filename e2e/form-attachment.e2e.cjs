/**
 * Campo do tipo "Anexo" no Gerenciador de formulários (13/11/2026): o arquivo escolhido no
 * formulário vai para "Documentos e anexos" da solicitação criada. Executado somente por
 * scripts/run-browser-tests.cjs. Dados fictícios, no banco descartável desta execução.
 */
const assert = require('node:assert/strict')

const adminEmail = 'e2e-admin@slm-e2e.invalid'

async function run({ playwright, baseUrl, password }) {
  const browser = await playwright.chromium.launch()
  const baseOrigin = new URL(baseUrl).origin
  const pageErrors = []
  try {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
    )
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const dialogs = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      return dialog.accept()
    })
    await page.goto('/entrar')
    await page.fill('#login-identifier', adminEmail)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')

    const api = (method, path, body) =>
      page.evaluate(
        async ({ method, path, body }) => {
          const me = await (await fetch('/api/auth/me')).json()
          const response = await fetch(`/api${path}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          return { status: response.status, body: await response.json().catch(() => ({})) }
        },
        { method, path, body },
      )

    // Opções mínimas do formulário de Manutenção.
    for (const [category, label] of [['floors', 'Andar do anexo'], ['serviceTypes', 'Serviço do anexo']]) {
      const created = await api('POST', `/settings/catalog/${category}`, { label })
      assert.ok([200, 201, 409].includes(created.status), `${category}: ${created.status}`)
    }

    // Publica a Manutenção com um campo novo do tipo Anexo, obrigatório.
    const form = await api('GET', '/config/forms/maintenance')
    assert.equal(form.status, 200)
    const base = form.body.published?.content ?? form.body.default
    const content = {
      ...base,
      fields: [
        ...base.fields.filter((field) => field.id !== 'custom-orcamento'),
        {
          id: 'custom-orcamento', label: 'Orçamento em arquivo', description: '', type: 'attachment', required: true,
          active: true, protected: false, section: base.sections[0].id, options: [], visibleTo: 'all', visibleWhen: null,
          minLength: null, maxLength: null, min: null, max: null, validation: 'none', help: '', placeholder: '',
        },
      ],
    }
    const published = await api('POST', '/config/forms/maintenance/publish', { conteudo: content, observacao: 'Campo de anexo (teste)' })
    assert.equal(published.status, 200, JSON.stringify(published.body))
    // Outro formulário recusa o tipo.
    const vehicle = await api('GET', '/config/forms/vehicle')
    const vehicleBase = vehicle.body.default
    const refused = await api('POST', '/config/forms/vehicle/publish', {
      conteudo: { ...vehicleBase, fields: [...vehicleBase.fields, { ...content.fields.at(-1), section: vehicleBase.sections[0].id }] },
      observacao: 'não deve publicar',
    })
    assert.equal(refused.status, 400)

    await page.goto('/manutencao/nova')
    await page.waitForSelector('select[name="andar"] option:not([value=""])', { state: 'attached' })
    const fileInput = page.locator('input[type="file"][name="custom-orcamento"]')
    await fileInput.waitFor({ state: 'attached' })
    assert.equal(await fileInput.getAttribute('required'), '')

    await page.selectOption('select[name="andar"]', { label: 'Andar do anexo' })
    await page.selectOption('select[name="tipoSolicitacao"]', { label: 'Serviço do anexo' })
    await page.fill('[name="localServico"]', 'Sala do anexo')
    await page.fill('[name="descricao"]', 'Troca de vidro com orçamento anexo')
    // PDF mínimo, só para o teste.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
    await fileInput.setInputFiles({ name: 'orcamento-vidro.pdf', mimeType: 'application/pdf', buffer: pdf })
    await page.click('button[type=submit]')
    await page.waitForSelector('.request-detail-page')
    assert.deepEqual(dialogs, [], 'sem aviso de falha no envio')

    const id = new URL(page.url()).pathname.split('/').pop()
    const listed = await api('GET', `/attachments/resources/service_request/${id}`)
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.attachments.map((item) => item.name), ['orcamento-vidro.pdf'])
    await page.locator('text=orcamento-vidro.pdf').first().waitFor()

    assert.deepEqual(pageErrors, [])
    console.log('  ok  campo de anexo: publicado, enviado com a solicitação e listado em Documentos e anexos')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
