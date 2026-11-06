/**
 * Supercomandos 06 e 07 no navegador: avisos, justificativa, devolução, duplicidade, exportação,
 * modelos e formulários. Executado somente por scripts/run-browser-tests.cjs, em banco descartável.
 */
const assert = require('node:assert/strict')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const requesterEmail = 'e2e-transp-solicitante@slm-e2e.invalid'

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
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 }, acceptDownloads: true })
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
    await page.goto('/')
    await page.fill('#login-identifier', email)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')
    return page
  }

  async function api(page, method, path, body) {
    return page.evaluate(
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
  }

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  const admin = await login(adminEmail)

  // Conta, catálogo e material, pelos fluxos reais.
  const anonymous = await browser.newContext({ baseURL: baseUrl })
  const anonymousPage = await anonymous.newPage()
  await anonymousPage.request.post('/api/auth/register', {
    data: { fullName: 'Solicitante Transparência', email: requesterEmail, sector: 'Protocolo', password, passwordConfirmation: password },
  })
  await anonymous.close()
  const pending = await api(admin, 'GET', '/admin/registrations/pending')
  const pendingId = pending.body.registrations.find((item) => item.email === requesterEmail).id
  assert.equal((await api(admin, 'POST', `/admin/registrations/${pendingId}/approve`, { role: 'requester' })).status, 200)
  const catalog = (await api(admin, 'GET', '/catalog')).body.catalog
  const ensure = async (category, label) =>
    catalog[category].find((item) => item.label === label)?.id ??
    (await api(admin, 'POST', `/settings/catalog/${category}`, { label })).body.option.id
  const floorId = await ensure('floors', 'Andar Transparência')
  const serviceTypeId = await ensure('serviceTypes', 'Serviço Transparência')
  await ensure('sectors', 'Setor Transparência')
  const unitId = await ensure('measurementUnits', 'Unidade Transparência')
  const material = await api(admin, 'POST', '/warehouse/materials', { name: `Material Transparência ${runId.slice(0, 6)}`, unitId })
  assert.equal(material.status, 201)

  // Agendar é da equipe SLM com concessão individual (P-08): a administradora, fora da equipe, não agenda.
  const slm = await login('e2e-slm@slm-e2e.invalid')
  const requester = await login(requesterEmail)

  await step('os quatro formulários mostram o aviso institucional e o de privacidade antes do envio', async () => {
    for (const [path, text] of [
      ['/manutencao/nova', 'As condições solicitadas'.toLowerCase()],
      ['/frota/nova', 'veículos, motoristas'],
      ['/passagens-aereas/nova', 'condições tarifárias'],
      ['/almoxarifado/nova', 'mesmo quando houver saldo em estoque'],
    ]) {
      await requester.goto(path)
      const notice = requester.locator('.service-notice')
      await notice.waitFor()
      assert.ok((await notice.innerText()).toLowerCase().includes(text.toLowerCase()), path)
      assert.equal(await requester.locator('.privacy-notice').count(), 1, path)
    }
  })

  let requestId
  await step('possível duplicidade alerta antes de enviar, e quem preenche decide', async () => {
    const description = 'Lâmpada queimada na sala de reuniões do terceiro andar'
    const created = await api(requester, 'POST', '/maintenance/requests', {
      andarId: floorId, tipoServicoId: serviceTypeId, localServico: 'Sala de reuniões', descricao: description,
      dataPreferencial: '2033-03-10T13:00:00.000Z',
    })
    assert.equal(created.status, 201)
    requestId = created.body.id

    await requester.goto('/manutencao/nova')
    await requester.selectOption('select[name=andar]', floorId)
    await requester.selectOption('select[name=tipoSolicitacao]', serviceTypeId)
    await requester.fill('textarea[name=descricao]', description)
    await requester.fill('input[name=localServico]', 'Sala de reuniões')
    await requester.click('.maintenance-submit-action button[type=submit]')
    const warning = requester.locator('[data-testid=duplicate-warning]')
    await warning.waitFor()
    assert.ok(await warning.locator(`a[href="/manutencao/${requestId}"]`).count())
    assert.ok(requester.url().endsWith('/manutencao/nova'), 'não envia sem a decisão')
    await warning.locator('button', { hasText: 'Enviar mesmo assim' }).click()
    await requester.waitForURL((url) => /\/manutencao\/[0-9a-f-]{36}$/.test(url.pathname))
  })

  await step('agendar fora do pedido pede motivo, e o histórico mostra a justificativa', async () => {
    // A tela da administradora fora da SLM não oferece o agendamento, e a API recusa da mesma forma.
    await admin.goto(`/manutencao/${requestId}`)
    await admin.locator('.request-timeline').waitFor()
    assert.equal(await admin.locator('.detail-action h3', { hasText: 'Agendar' }).count(), 0, 'administradora sem o formulário de agendamento')
    assert.equal((await api(admin, 'POST', `/maintenance/requests/${requestId}/schedule`, { dataAgendada: '2033-03-12T13:00:00.000Z', motivoCodigo: 'conflito_agenda' })).status, 403)

    await slm.goto(`/manutencao/${requestId}`)
    const form = slm.locator('.detail-action', { hasText: 'Agendar' }).first()
    await form.locator('input[type=datetime-local]').first().fill('2033-03-12T10:00')
    await form.locator('.ui-alert-warning', { hasText: 'Diferente do que foi solicitado' }).waitFor()
    await form.locator('select').last().selectOption('conflito_agenda')
    await form.locator('button[type=submit]').click()
    await slm.locator('.request-timeline', { hasText: 'Conflito de agenda' }).waitFor()
  })

  await step('devolução: o solicitante vê o que corrigir e corrige só os campos indicados', async () => {
    const second = await api(requester, 'POST', '/maintenance/requests', {
      andarId: floorId, tipoServicoId: serviceTypeId, localServico: 'Garagem', descricao: 'Portão com defeito',
    })
    const path = `/manutencao/${second.body.id}`
    await admin.goto(path)
    const form = admin.locator('.detail-action', { hasText: 'Devolver ao solicitante' })
    await form.locator('textarea').fill('Informe a sala do portão')
    await form.locator('label', { hasText: 'Sala' }).locator('input[type=checkbox]').check()
    await form.locator('button[type=submit]').click()
    await admin.locator('[data-testid=open-return]').waitFor()

    await requester.goto(path)
    const open = requester.locator('[data-testid=open-return]')
    await open.waitFor()
    assert.match(await open.innerText(), /Informe a sala do portão/)
    assert.match(await open.innerText(), /O que corrigir: Sala/)
    const correction = requester.locator('.detail-action', { hasText: 'Corrigir a solicitação' })
    await correction.locator('label', { hasText: 'Sala' }).locator('input').fill('Sala 7')
    await correction.locator('button[type=submit]').click()
    await requester.locator('.detail-history', { hasText: 'Respondida' }).waitFor()
    assert.equal(await requester.locator('[data-testid=open-return]').count(), 0)
    await requester.locator('.detail-info', { hasText: 'Sala 7' }).waitFor()
  })

  await step('relatório individual baixa um PDF de verdade', async () => {
    await requester.goto(`/manutencao/${requestId}`)
    const [download] = await Promise.all([
      requester.waitForEvent('download'),
      requester.locator('.report-export a', { hasText: 'PDF' }).click(),
    ])
    assert.match(download.suggestedFilename(), /^solicitacao-.+\.pdf$/)
  })

  await step('modelos de e-mail: edição, validação, prévia e publicação pela tela', async () => {
    await admin.goto('/configuracoes')
    await admin.locator('summary', { hasText: 'Abrir modelos de e-mail' }).click()
    const editor = admin.locator('[data-testid=template-editor]')
    await editor.waitFor()
    await admin.locator('section[aria-labelledby=settings-email-templates] select').first().selectOption('request_scheduled')
    await editor.getByRole('textbox', { name: 'Assunto *' }).fill('Agendado para {{data_agendada}}')
    await editor.locator('label', { hasText: 'Saudação' }).locator('input').fill('Olá, {{nome_solicitante}}')

    await editor.locator('label', { hasText: 'Texto principal' }).locator('textarea').fill('<script>alert(1)</script>')
    await editor.locator('button', { hasText: 'Visualizar e validar' }).click()
    await editor.locator('.ui-alert-error', { hasText: '< >' }).waitFor()

    await editor.locator('label', { hasText: 'Texto principal' }).locator('textarea').fill('Tudo **certo** com seu atendimento.')
    await editor.locator('button', { hasText: 'Visualizar e validar' }).click()
    const preview = admin.locator('[data-testid=template-preview]')
    await preview.waitFor()
    assert.match(await preview.innerText(), /dados de exemplo/)
    assert.match(await preview.innerText(), /Agendado para 15\/01\/2030/)
    const html = await preview.locator('iframe').getAttribute('srcdoc')
    assert.ok(html.includes('<strong>certo</strong>'))
    assert.equal(await preview.locator('iframe').getAttribute('sandbox'), '')

    await editor.locator('button', { hasText: 'Enviar teste' }).click()
    await editor.locator('.ui-alert-success', { hasText: 'simulado' }).waitFor()
    await editor.locator('button', { hasText: 'Publicar' }).click()
    await editor.locator('.ui-alert-success', { hasText: 'publicado' }).waitFor()
    await editor.locator('summary', { hasText: 'Histórico de versões' }).click()
    await editor.locator('.detail-history', { hasText: 'publicada' }).waitFor()
  })

  await step('formulários: rascunho não muda nada, e publicar vale de verdade no formulário', async () => {
    await admin.goto('/configuracoes')
    await admin.locator('summary', { hasText: 'Abrir gerenciador de formulários' }).click()
    const editor = admin.locator('[data-testid=form-editor]')
    await editor.waitFor()
    const fieldName = `Ramal da execução ${runId.slice(0, 6)}`
    await editor.locator('button', { hasText: 'Adicionar campo' }).click()
    const field = editor.locator('details[data-field^=custom-]').last()
    await field.locator('summary').click()
    await field.locator('label', { hasText: 'Nome' }).first().locator('input').fill(fieldName)
    await field.locator('label', { hasText: 'Regra de validação' }).locator('select').selectOption('digits')
    await field.locator('label', { hasText: 'Obrigatório' }).locator('input').check()

    await editor.locator('button', { hasText: 'Pré-visualizar' }).click()
    const preview = admin.locator('[data-testid=form-preview]')
    await preview.waitFor()
    assert.ok((await preview.innerText()).includes(fieldName))

    await editor.locator('button', { hasText: 'Salvar rascunho' }).click()
    await editor.locator('.ui-alert-success', { hasText: 'Rascunho salvo' }).waitFor()
    await requester.goto('/manutencao/nova')
    await requester.locator('.service-notice').waitFor()
    assert.equal(await requester.locator('label', { hasText: fieldName }).count(), 0, 'rascunho não vale')

    await editor.locator('button', { hasText: 'Publicar' }).click()
    await editor.locator('.ui-alert-success', { hasText: 'publicado' }).waitFor()
    await requester.goto('/manutencao/nova')
    await requester.locator('label', { hasText: fieldName }).waitFor()
    assert.equal(await requester.locator('.service-notice').count(), 1, 'o aviso continua depois de personalizar')

    // Sem o campo novo, o servidor recusa, mesmo fora da tela.
    const refused = await api(requester, 'POST', '/maintenance/requests', {
      andarId: floorId, tipoServicoId: serviceTypeId, localServico: 'Hall', descricao: 'Sem o ramal',
    })
    assert.equal(refused.status, 400)
    assert.ok(refused.body.message.includes(fieldName))

    const base = (await api(admin, 'GET', '/config/forms/maintenance')).body.default
    assert.equal((await api(admin, 'POST', '/config/forms/maintenance/publish', { conteudo: base })).status, 200)
  })

  await step('controle interno do Almoxarifado grava pela tela, sem criar pedido', async () => {
    const before = (await api(admin, 'GET', '/warehouse/requests')).body.total
    await admin.goto('/almoxarifado/controle')
    const form = admin.locator('section[aria-labelledby=control-new] form')
    await form.locator('label', { hasText: 'Material' }).locator('select').selectOption(material.body.id)
    await form.locator('label', { hasText: 'Quantidade de referência' }).locator('input').fill('10')
    await form.locator('label', { hasText: 'Quantidade conferida' }).locator('input').fill('8')
    await form.locator('button[type=submit]').click()
    await form.locator('.ui-alert-error', { hasText: 'justificativa' }).waitFor()
    await form.locator('label', { hasText: 'Justificativa' }).locator('textarea').fill('Duas caixas avariadas')
    await form.locator('button[type=submit]').click()
    await admin.locator('section[aria-labelledby=control-history]', { hasText: 'Duas caixas avariadas' }).waitFor()
    assert.equal((await api(admin, 'GET', '/warehouse/requests')).body.total, before)
  })

  await step('acessibilidade: atalho para o conteúdo e foco visível pelo teclado', async () => {
    await admin.goto('/')
    await admin.waitForSelector('.topbar-logout')
    await admin.keyboard.press('Tab')
    const focused = await admin.evaluate(() => document.activeElement?.className)
    assert.match(String(focused), /skip-link/)
    assert.equal(await admin.locator('#conteudo-principal').count(), 1)
  })

  assert.deepEqual(violations, [], 'resposta fora desta execução')
  assert.deepEqual(pageErrors, [], 'erros de JavaScript nas páginas')
}

module.exports = { run }
