/**
 * Central de comunicação no navegador: mensagem com anexo, encaminhamento de passagem, indicador e
 * reenvio. Executado somente por scripts/run-browser-tests.cjs, em banco descartável e com o
 * transporte simulado, que não sai da máquina.
 */
const assert = require('node:assert/strict')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const requesterEmail = 'e2e-comunica-solicitante@slm-e2e.invalid'
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

async function run({ playwright, baseUrl, runId, password }) {
  const browser = await playwright.chromium.launch()
  try {
    await scenarios({ browser, baseUrl, runId, password })
  } finally {
    await browser.close()
  }
}

async function scenarios({ browser, baseUrl, runId, password }) {
  const origin = new URL(baseUrl).origin
  const violations = []
  const pageErrors = []

  async function login(email) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } })
    context.setDefaultTimeout(20000)
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    )
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/') && response.headers()['x-slm-e2e-run'] !== runId) violations.push(url.pathname)
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto('/entrar')
    await page.fill('#login-identifier', email)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')
    return page
  }

  const api = (page, method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const me = await (await fetch('/api/auth/me')).json()
        const response = await fetch(`/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() }
      },
      { method, path, body },
    )

  async function until(check) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (await check()) return
      await new Promise((done) => setTimeout(done, 1000))
    }
    throw new Error('O envio simulado não foi processado a tempo.')
  }

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  const admin = await login(adminEmail)
  const anonymous = await browser.newContext({ baseURL: baseUrl })
  const anonymousPage = await anonymous.newPage()
  await anonymousPage.request.post('/api/auth/register', {
    data: { fullName: 'Solicitante Comunicação', email: requesterEmail, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  await anonymous.close()
  const pending = await api(admin, 'GET', '/admin/registrations/pending')
  const pendingId = pending.body.registrations.find((item) => item.email === requesterEmail).id
  assert.equal((await api(admin, 'POST', `/admin/registrations/${pendingId}/approve`, { role: 'requester' })).status, 200)
  const catalog = (await api(admin, 'GET', '/catalog')).body.catalog
  const ensure = async (category, label) =>
    catalog[category].find((item) => item.label === label)?.id ??
    (await api(admin, 'POST', `/settings/catalog/${category}`, { label })).body.option.id
  const floorId = await ensure('floors', 'Andar Comunicação')
  const serviceTypeId = await ensure('serviceTypes', 'Serviço Comunicação')
  const requester = await login(requesterEmail)

  await step('e-mail com anexo: conferir, confirmar, registrar, e reenviar sem perder o anterior', async () => {
    const created = await api(requester, 'POST', '/maintenance/requests', {
      andarId: floorId, tipoServicoId: serviceTypeId, localServico: `Local ${runId.slice(0, 6)}`, descricao: `Comunicação ${runId.slice(0, 6)}`,
    })
    assert.equal(created.status, 201)

    // Quem só solicita não tem o painel.
    await requester.goto(`/manutencao/${created.body.id}`)
    await requester.waitForSelector('.request-detail-page')
    assert.equal(await requester.locator('[data-testid=communications]').count(), 0)

    await admin.goto(`/manutencao/${created.body.id}`)
    const panel = admin.locator('[data-testid=communications]')
    await panel.locator('button', { hasText: 'Enviar e-mail' }).click()
    const form = admin.locator('[data-testid=email-composer]')
    await form.waitFor()
    assert.equal(await form.locator('label', { hasText: 'Destinatários' }).locator('input').inputValue(), requesterEmail, 'parte dos dados cadastrados')

    await form.locator('label', { hasText: 'Modelo' }).locator('select').selectOption('manual_message')
    await form.locator('button', { hasText: 'Preencher com o modelo' }).click()
    await admin.waitForFunction(() => document.querySelector('[data-testid=email-composer] textarea')?.value.includes('JUCESP'))
    const body = form.locator('label', { hasText: 'Mensagem' }).locator('textarea')
    assert.ok(!(await body.inputValue()).includes('{{'))
    await body.fill(`${await body.inputValue()}\nSegue o orçamento.`)

    // Tipo de arquivo perigoso é recusado no envio do arquivo.
    await form.locator('[data-testid=composer-file]').setInputFiles({ name: 'orcamento.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ') })
    await form.locator('.ui-alert-error').waitFor()
    await form.locator('[data-testid=composer-file]').setInputFiles({ name: 'orcamento.pdf', mimeType: 'application/pdf', buffer: pdf })
    const attached = form.locator('fieldset label', { hasText: 'orcamento.pdf' }).locator('input')
    await attached.waitFor()
    assert.equal(await attached.isChecked(), true)
    // Remover antes de enviar e selecionar de novo.
    await attached.uncheck()
    await attached.check()

    await form.locator('button', { hasText: 'Conferir antes de enviar' }).click()
    const review = admin.locator('[data-testid=email-review]')
    await review.waitFor()
    assert.match(await review.innerText(), /orcamento\.pdf/)
    assert.match(await review.innerText(), /Nada foi enviado ainda/)
    assert.equal(await review.locator('iframe').getAttribute('sandbox'), '')
    assert.deepEqual((await api(admin, 'GET', `/communications/service_request/${created.body.id}`)).body.history, [], 'só envia depois de confirmar')

    await review.locator('button', { hasText: 'Confirmar envio' }).click()
    const item = panel.locator('.detail-history li').first()
    await item.waitFor()
    assert.match(await item.innerText(), /orcamento\.pdf/)

    // O worker da execução processa a fila com o transporte simulado, e a tela diz isso.
    await until(async () => (await api(admin, 'GET', `/communications/service_request/${created.body.id}`)).body.history[0]?.status === 'sent')
    await admin.reload()
    await item.waitFor()
    assert.match(await item.innerText(), /simulado, nada saiu da máquina/)
    await item.locator('summary').click()
    assert.match(await item.innerText(), /Segue o orçamento/)

    await item.locator('button', { hasText: 'Reenviar' }).click()
    await admin.locator('button', { hasText: 'Confirmar reenvio' }).click()
    await panel.locator('.ui-alert-info', { hasText: 'registro anterior foi mantido' }).waitFor()
    await panel.locator('.detail-history li').nth(1).waitFor()
    assert.equal(await panel.locator('.detail-history li').count(), 2)
  })

  await step('passagem: dados do voo preenchidos, bilhete exigido, indicador na lista e no detalhe', async () => {
    const created = await api(requester, 'POST', '/flights/requests', {
      andarId: floorId,
      tipoViagem: 'somente_ida',
      ida: { origem: 'Origem E2E', destino: 'Destino E2E', data: '2033-05-10', horario: '10:00' },
      passageiros: [{ nome: 'Passageira E2E', cpf: '52998224725' }],
    })
    assert.equal(created.status, 201)
    const id = created.body.id
    await admin.goto(`/passagens-aereas/${id}`)
    const panel = admin.locator('[data-testid=communications]')
    await panel.locator('[data-testid=ticket-status]', { hasText: 'Bilhete não enviado' }).waitFor()
    await panel.locator('button', { hasText: 'Enviar passagem por e-mail' }).click()
    const form = admin.locator('[data-testid=email-composer]')
    await form.waitFor()
    const passenger = form.locator('label', { hasText: 'Passageiro' }).locator('select')
    await passenger.selectOption({ index: 1 })
    assert.ok(!(await form.innerText()).includes('52998224725'), 'o CPF aparece mascarado')
    await form.locator('label', { hasText: 'Localizador' }).locator('input').fill('LOC123')
    await form.locator('button', { hasText: 'Preencher com o modelo' }).click()
    await admin.waitForFunction(() => document.querySelector('[data-testid=email-composer] textarea')?.value.includes('LOC123'))
    const text = await form.locator('label', { hasText: 'Mensagem' }).locator('textarea').inputValue()
    for (const expected of ['Passageira E2E', 'Origem E2E → Destino E2E', 'LOC123']) assert.ok(text.includes(expected), expected)
    await form.locator('label', { hasText: 'E-mail do passageiro' }).locator('input').fill('passageira-e2e@slm-e2e.invalid')

    await form.locator('button', { hasText: 'Conferir antes de enviar' }).click()
    await form.locator('.ui-alert-error', { hasText: 'Anexe o bilhete' }).waitFor()
    await form.locator('[data-testid=composer-file]').setInputFiles({ name: 'bilhete.pdf', mimeType: 'application/pdf', buffer: pdf })
    await form.locator('fieldset label', { hasText: 'bilhete.pdf' }).waitFor()
    await form.locator('button', { hasText: 'Conferir antes de enviar' }).click()
    const review = admin.locator('[data-testid=email-review]')
    await review.waitFor()
    assert.match(await review.innerText(), /Passageira E2E/)
    await review.locator('button', { hasText: 'Confirmar envio' }).click()

    await panel.locator('.detail-history li').first().waitFor()
    await until(async () => (await api(admin, 'GET', `/communications/service_request/${id}`)).body.ticketStatus === 'enviado')
    await admin.reload()
    await panel.locator('[data-testid=ticket-status]', { hasText: 'Bilhete enviado' }).waitFor()
    assert.equal((await api(admin, 'GET', `/flights/requests/${id}`)).body.request.status, 'em_cotacao', 'o status não muda')

    await admin.goto('/passagens-aereas')
    await admin.locator('tr', { hasText: created.body.protocol }).locator('td', { hasText: 'Bilhete enviado' }).waitFor()
    await requester.goto('/passagens-aereas')
    await requester.locator('tr', { hasText: created.body.protocol }).waitFor()
    assert.equal(await requester.locator('th', { hasText: 'Bilhete' }).count(), 0)
  })

  await step('configurações: limites da comunicação e criação de modelo próprio', async () => {
    await admin.goto('/configuracoes')
    const block = admin.locator('form', { has: admin.locator('h3', { hasText: 'Central de comunicação' }) })
    await block.waitFor()
    await block.getByLabel('Destinatários por mensagem').fill('5')
    await block.getByRole('button', { name: 'Salvar' }).click()
    await block.locator('.ui-alert-success').waitFor()

    await admin.locator('summary', { hasText: 'Abrir modelos de e-mail' }).click()
    const creator = admin.locator('[data-testid=new-template]')
    await creator.waitFor()
    await creator.locator('label', { hasText: 'Nome' }).locator('input').fill('Bilhete com orientações')
    await creator.locator('label', { hasText: 'Evento' }).locator('select').selectOption('flight_ticket_delivery')
    await creator.locator('button', { hasText: 'Criar modelo' }).click()
    const editor = admin.locator('[data-testid=template-editor]')
    await editor.locator('.detail-history', { hasText: 'rascunho' }).waitFor({ state: 'attached' })
    assert.equal(await editor.getByLabel('Nome do modelo').inputValue(), 'Bilhete com orientações')
  })

  assert.deepEqual(violations, [], 'resposta fora desta execução')
  assert.deepEqual(pageErrors, [], 'erros de JavaScript nas páginas')
}

module.exports = { run }
