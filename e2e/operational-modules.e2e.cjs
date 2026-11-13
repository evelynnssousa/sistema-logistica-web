/**
 * Fluxos dos módulos no navegador, depois de access-control.e2e.cjs. Executado somente por
 * scripts/run-browser-tests.cjs, que fornece o endereço isolado e a senha aleatória.
 * Os dados são fictícios e ficam no banco descartável desta execução.
 */
const assert = require('node:assert/strict')

// O cenário anterior desativa suas contas de teste: este cria as próprias.
const emails = {
  admin: 'e2e-admin@slm-e2e.invalid',
  requester: 'e2e-modulos-solicitante@slm-e2e.invalid',
  operator: 'e2e-modulos-operadora@slm-e2e.invalid',
}

// Número sem dono: base fictícia com dígitos verificadores calculados.
const fictionalCpf = '000.000.001-91'

async function run({ playwright, baseUrl, runId, password }) {
  const browser = await playwright.chromium.launch()
  const pageErrors = []
  const violations = []
  const baseOrigin = new URL(baseUrl).origin

  // Chamada direta à API com a sessão e o token CSRF da página, para provar que a recusa não é só da tela.
  const api = (page, method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const me = await (await fetch('/api/auth/me')).json()
        const response = await fetch(`/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: response.status }
      },
      { method, path, body },
    )

  async function login(email) {
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1360, height: 900 },
    })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
    )
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/') && response.headers()['x-slm-e2e-run'] !== runId) {
        violations.push(url.pathname)
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto('/entrar')
    await page.fill('#login-identifier', email)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')
    return page
  }

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  async function addOption(page, sectionTitle, label) {
    const card = page.locator('.settings-card', { has: page.locator('h2', { hasText: sectionTitle }) })
    await card.locator('.settings-card-actions button').click()
    await card.locator('.settings-add-form input').first().fill(label)
    await card.locator('.settings-add-form button[type=submit]').click()
    await card.locator('.settings-option-label', { hasText: label }).waitFor()
  }

  const selectByLabel = (page, name, label) => page.selectOption(`select[name="${name}"]`, { label })

  async function grant(admin, page, permissions) {
    const userId = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id)
    await admin.goto(`/usuarios/${userId}`)
    await admin.waitForSelector('.users-permission')
    for (const permission of permissions) {
      await admin.locator('.users-permission', { hasText: permission }).locator('select').selectOption('grant')
    }
    await admin.click('button:has-text("Salvar acesso")')
    if (permissions.includes('flights:cpf:read')) await admin.click('[data-confirm]')
    await admin.waitForSelector('.page-section > [role=status]')
  }

  async function register(name, email, sector) {
    const context = await browser.newContext({ baseURL: baseUrl })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
    )
    const page = await context.newPage()
    await page.goto('/entrar')
    await page.click('.login-register-link button')
    await page.fill('#register-name', name)
    await page.fill('#register-email', email)
    await page.fill('#register-sector', sector)
    const fields = await page.$$('input[type=password]')
    await fields[0].fill(password)
    await fields[1].fill(password)
    await page.click('.login-submit')
    await page.waitForSelector('[role=status]')
    await context.close()
  }

  try {
    const admin = await login(emails.admin)
    await register('Pessoa Solicitante', emails.requester, 'Protocolo')
    await register('Pessoa Operadora', emails.operator, 'CPC')
    await admin.goto('/cadastros-pendentes')
    await admin.waitForSelector('.data-table')
    for (const [email, role] of [[emails.requester, 'requester'], [emails.operator, 'slm_operator']]) {
      const row = admin.locator('.data-table tbody tr', { hasText: email })
      await row.locator('select').selectOption(role)
      await row.locator('.table-actions button').first().click()
      await admin.click('[data-confirm]')
      await row.waitFor({ state: 'detached' })
    }

    const requester = await login(emails.requester)
    const operator = await login(emails.operator)
    let maintenanceUrl

    await step('administradora cadastra as listas padronizadas em Configurações', async () => {
      await admin.goto('/configuracoes?aba=listas')
      await admin.waitForSelector('.settings-grid')
      await addOption(admin, 'Setores', 'Protocolo')
      await addOption(admin, 'Andares', '1º andar')
      await addOption(admin, 'Tipos de serviços', 'Elétrica')
      await addOption(admin, 'Unidades de medida', 'Unidade')

      // Duplicidade é recusada pelo servidor, com mensagem.
      const card = admin.locator('.settings-card', { has: admin.locator('h2', { hasText: 'Andares' }) })
      await card.locator('.settings-card-actions button').click()
      await card.locator('.settings-add-form input').first().fill('1º ANDAR')
      await card.locator('.settings-add-form button[type=submit]').click()
      await card.locator('.settings-feedback.error').waitFor()
      await card.locator('.settings-add-form button[type=button]').click()
    })

    await step('solicitante abre manutenção com seletores do servidor e identidade da sessão', async () => {
      await requester.goto('/manutencao/nova')
      await requester.waitForSelector('select[name="andar"] option:not([value=""])', { state: 'attached' })
      const readOnly = await requester.locator('input[readonly]').evaluateAll((inputs) => inputs.map((input) => input.value))
      assert.ok(readOnly.includes('Pessoa Solicitante'))
      assert.ok(readOnly.includes(emails.requester))

      await selectByLabel(requester, 'andar', '1º andar')
      await selectByLabel(requester, 'tipoSolicitacao', 'Elétrica')
      await requester.fill('[name="localServico"]', 'Sala de arquivo')
      await requester.fill('[name="descricao"]', 'Lâmpada queimada')
      await requester.click('button[type=submit]')
      await requester.waitForSelector('.request-detail-page')
      assert.equal(await requester.textContent('.detail-status'), 'Aguardando agendamento')
      maintenanceUrl = new URL(requester.url()).pathname

      // Solicitante não vê ações de atendimento.
      assert.equal(await requester.locator('.detail-action').count(), 0)
    })

    await step('o agendamento aparece pelo perfil do Operador SLM da equipe, sem concessão manual', async () => {
      await operator.goto(maintenanceUrl)
      await operator.waitForSelector('.request-detail-page')
      await operator.locator('.detail-action h3', { hasText: 'Agendar' }).waitFor()
      const me = await operator.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user)
      assert.equal(me.slmMember, true)
      assert.ok(me.permissions.includes('requests:schedule'))
    })

    await step('operadora agenda, reagenda, inicia e conclui; o histórico acompanha', async () => {
      const form = () => operator.locator('.detail-action', { has: operator.locator('h3', { hasText: /agendar/i }) })
      const inFuture = (days) => {
        const date = new Date(Date.now() + days * 86_400_000)
        const pad = (value) => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`
      }

      await form().locator('input[type=datetime-local]').first().fill(inFuture(2))
      await form().locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Agendado' }).waitFor()

      await form().locator('input[type=datetime-local]').first().fill(inFuture(3))
      await form().locator('label', { hasText: 'Motivo da alteração' }).locator('select').selectOption('equipe_indisponivel')
      await form().locator('textarea').fill('Equipe indisponível')
      await form().locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Reagendado' }).waitFor()

      await operator.goto('/calendario')
      await operator.locator('.calendar-view-controls button', { hasText: 'Semana' }).click()
      for (let attempts = 0; attempts < 2; attempts += 1) {
        if (await operator.locator('.calendar-event').count()) break
        await operator.click('[aria-label="Período seguinte"]')
        await operator.waitForTimeout(300)
      }
      // A agenda abre os detalhes do compromisso, com o caminho para a solicitação.
      await operator.locator('.calendar-event', { hasText: 'Elétrica' }).click()
      await operator.locator('dialog.ui-modal a', { hasText: 'Abrir solicitação' }).click()
      await operator.waitForSelector('.request-detail-page')

      await operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'Iniciar' }) }).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Em andamento' }).waitFor()
      await operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'Concluir' }) }).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Concluído' }).waitFor()

      const history = await operator.locator('.request-timeline > li[data-kind="history"] strong').allTextContents()
      assert.deepEqual(history, [
        'Solicitação criada',
        'Agendamento realizado',
        'Reagendamento',
        'Atendimento iniciado',
        'Atendimento concluído',
      ])
    })

    await step('frota: solicitação, execução e registro de atraso', async () => {
      await requester.goto('/frota/nova')
      await requester.fill('[name="origin"]', 'Sede')
      await requester.fill('[name="destination"]', 'Fórum')
      await requester.fill('[name="departureAt"]', '2031-03-10T10:00')
      await requester.fill('[name="serviceRequested"]', 'Entrega de documentos')
      await requester.fill('[name="passengerNames"]', 'Pessoa Fictícia')
      await requester.click('button[type=submit]')
      await requester.waitForSelector('.request-detail-page')
      const path = new URL(requester.url()).pathname

      await operator.goto(path)
      const schedule = operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'Agendar' }) })
      await schedule.locator('input[type=datetime-local]').first().fill('2031-03-10T10:00')
      await schedule.locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Agendado' }).waitFor()

      await operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'Iniciar' }) }).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Em andamento' }).waitFor()

      const occurrence = operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'ocorrência' }) })
      await occurrence.locator('select').selectOption('atraso')
      await occurrence.locator('input[type=number]').fill('15')
      await occurrence.locator('textarea').fill('Trânsito intenso')
      await occurrence.locator('button[type=submit]').click()
      await operator.locator('.detail-history strong', { hasText: 'Atraso de 15 min' }).waitFor()
    })

    await step('passagens: CPF mascarado para todos e completo só com a concessão', async () => {
      await requester.goto('/passagens-aereas/nova')
      await selectByLabel(requester, 'requesterFloor', '1º andar')
      await requester.fill('[name="passengerName"]', 'Passageira Fictícia')
      await requester.fill('[name="passengerCpf"]', fictionalCpf)
      await requester.fill('[name="outboundOrigin"]', 'GRU')
      await requester.fill('[name="outboundDestination"]', 'BSB')
      await requester.fill('[name="departureDate"]', '2031-04-01')
      await requester.fill('[name="departureTime"]', '08:00')
      await requester.selectOption('select[name="baggage"]', { label: 'Bagagem de mão' })
      await requester.click('button[type=submit]')
      await requester.waitForSelector('.request-detail-page')
      assert.equal(await requester.textContent('.detail-status'), 'Em cotação')
      const body = await requester.textContent('.request-detail-page')
      assert.ok(body.includes('***.000.001-**'))
      assert.ok(!body.includes(fictionalCpf))
      assert.equal(await requester.locator('button:has-text("Ver CPF completo")').count(), 0)
      const path = new URL(requester.url()).pathname

      await operator.goto(path)
      await operator.waitForSelector('.request-detail-page')
      assert.equal(await operator.locator('button:has-text("Ver CPF completo")').count(), 0)
      await grant(admin, operator, ['flights:cpf:read'])
      await operator.goto(path)
      await operator.click('button:has-text("Ver CPF completo")')
      await operator.locator('td', { hasText: '00000000191' }).waitFor()

      await operator.locator('.detail-action', { has: operator.locator('h3', { hasText: 'Avançar' }) }).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Aguardando aprovação' }).waitFor()
    })

    await step('almoxarifado: catálogo, pedido interno, pedido externo e entrega', async () => {
      // Sem warehouse:manage, a central não mostra as abas de gestão ao Solicitante.
      await requester.goto('/almoxarifado')
      await requester.waitForSelector('.inventory-page')
      await requester.locator('.module-tabs a', { hasText: 'Solicitações' }).waitFor()
      assert.equal(await requester.locator('.module-tabs a', { hasText: 'Materiais' }).count(), 0)
      assert.equal(await requester.locator('.module-tabs a', { hasText: 'Estoque interno' }).count(), 0)
      await requester.goto('/almoxarifado/materiais')
      await requester.waitForSelector('.access-denied')
      // O Operador SLM da equipe gerencia o Almoxarifado pelo perfil.
      await operator.goto('/almoxarifado')
      await operator.waitForSelector('.inventory-page')
      await operator.locator('.module-tabs a', { hasText: 'Materiais' }).waitFor()
      await operator.locator('.module-tabs a', { hasText: 'Estoque interno' }).waitFor()

      // O endereço antigo do portal cai dentro do módulo, com o menu do sistema.
      await operator.goto('/portal/almoxarifado')
      await operator.waitForSelector('.inventory-page')
      assert.equal(new URL(operator.url()).pathname, '/almoxarifado/nova')
      assert.equal(await operator.locator('.nav-item.active .nav-label').textContent(), 'Almoxarifado')

      await admin.goto('/almoxarifado')
      await admin.locator('.module-tabs a', { hasText: 'Materiais' }).click()
      await admin.locator('.detail-action input').first().fill('Papel A4')
      await admin.selectOption('.detail-action select >> nth=0', { label: 'Unidade' })
      await admin.locator('.detail-action button[type=submit]').click()
      await admin.locator('.data-table td', { hasText: 'Papel A4' }).waitFor()

      // O portal mostra o catálogo real, sem dados de demonstração.
      await requester.goto('/almoxarifado/nova')
      await requester.locator('.warehouse-material-card', { hasText: 'Papel A4' }).waitFor()
      assert.equal(await requester.locator('text=Detergente').count(), 0)
      await requester.fill('[aria-label="Quantidade de Papel A4"]', '5')
      await requester.click('button:has-text("Enviar solicitação")')
      await requester.waitForSelector('.warehouse-request-page')
      assert.equal(await requester.textContent('.detail-status'), 'Pendente')
      assert.equal(await requester.locator('.detail-action').count(), 0)
      const path = new URL(requester.url()).pathname

      await admin.goto('/almoxarifado')
      await admin.locator('.module-tabs a', { hasText: 'Pedido externo' }).click()
      const notice = await admin.textContent('.module-notice')
      assert.match(notice, /não está integrado/)
      const form = admin.locator('.detail-action')
      await form.locator('input').first().fill('GOV-0001')
      await form.locator('select').first().selectOption({ label: 'Protocolo' })
      await form.locator('.warehouse-cart-row select').selectOption({ label: 'Papel A4 (Unidade)' })
      await form.locator('.warehouse-cart-row input').first().fill('2')
      await form.locator('button[type=submit]').click()
      await admin.waitForSelector('.warehouse-request-page')
      assert.match(await admin.textContent('.eyebrow'), /governamental/)

      await admin.goto('/almoxarifado/solicitacoes')
      await admin.locator('.data-table td', { hasText: 'GOV-0001' }).waitFor()
      assert.equal(await admin.locator('.data-table td', { hasText: 'Sistema JUCESP' }).count(), 1)

      await admin.goto(path)
      await admin.waitForSelector('.warehouse-request-page')
      const items = admin.locator('.detail-action', { has: admin.locator('h3', { hasText: 'Itens' }) })
      await items.locator('input').nth(1).fill('5')
      await items.locator('button[type=submit]').click()
      await admin.locator('[role=status]', { hasText: 'Itens atualizados' }).waitFor()
      const status = admin.locator('.detail-action', { has: admin.locator('h3', { hasText: 'Alterar situação' }) })
      await status.locator('select').selectOption('atendido')
      await status.locator('button[type=submit]').click()
      await admin.locator('.detail-status', { hasText: 'Atendido' }).waitFor()
      // P-08: a administradora fora da SLM gere o pedido, mas a tela não oferece a previsão, e a API recusa.
      assert.equal(await admin.locator('.detail-action h3', { hasText: 'previsão de entrega' }).count(), 0)
      assert.ok(await admin.locator('.detail-action h3', { hasText: 'Registrar entrega' }).count(), 'a entrega continua com ela')
      const requestId = path.split('/').pop()
      assert.equal((await api(admin, 'PUT', `/warehouse/requests/${requestId}/delivery-forecast`, { date: '2031-03-10' })).status, 403)

      // Uma previsão não conclui a entrega: só o registro efetivo conclui. Quem informa é a SLM.
      const slm = await login('e2e-slm@slm-e2e.invalid')
      await slm.goto(path)
      await slm.waitForSelector('.warehouse-request-page')
      const forecast = slm.locator('.detail-action', { has: slm.locator('h3', { hasText: 'previsão de entrega' }) })
      await forecast.locator('input[type=date]').fill('2031-03-10')
      await forecast.locator('button[type=submit]').click()
      await slm.locator('[role=status]', { hasText: 'O solicitante será avisado' }).waitFor()
      assert.ok((await slm.textContent('[aria-label="Entrega dos materiais"]')).includes('10/03/2031'))
      assert.equal(await slm.locator('[aria-label="Entrega dos materiais"] [data-status=aguardando_entrega]').count(), 1)

      // Alterar a data pede justificativa, que fica só no histórico interno.
      await forecast.locator('input[type=date]').fill('2031-03-20')
      await forecast.locator('textarea').fill('Fornecedor atrasou')
      await forecast.locator('button[type=submit]').click()
      await slm.locator('[aria-label="Entrega dos materiais"] [data-status=entrega_reagendada]').waitFor()
      await slm.locator('.detail-history', { hasText: 'Justificativa: Fornecedor atrasou' }).waitFor()
      await admin.reload()
      await admin.waitForSelector('.warehouse-request-page')

      await requester.goto(path)
      await requester.waitForSelector('.warehouse-request-page')
      assert.ok((await requester.textContent('[aria-label="Entrega dos materiais"]')).includes('20/03/2031'))
      assert.equal(await requester.locator('text=Fornecedor atrasou').count(), 0)

      const delivery = admin.locator('.detail-action', { has: admin.locator('h3', { hasText: 'Registrar entrega' }) })
      await delivery.locator('input[name=recebidoPor]').fill('Pessoa Recebedora')
      await delivery.locator('textarea').fill('Entregue na recepção')
      await delivery.locator('button[type=submit]').click()
      await admin.locator('.detail-status', { hasText: 'Entregue' }).waitFor()
      await admin.locator('[aria-label="Entrega dos materiais"] [data-status=entregue]').waitFor()

      await requester.reload()
      await requester.locator('[aria-label="Entrega dos materiais"] [data-status=entregue]').waitFor()
      assert.equal(await requester.locator('text=Entregue na recepção').count(), 0)

      // Pedido digitado com o e-mail da pessoa: ela acompanha, sem ver os dados internos.
      await admin.goto('/almoxarifado/externo')
      const typed = admin.locator('.detail-action')
      await typed.locator('input').first().fill('GOV-0002')
      await typed.locator('input[type=email]').fill(emails.requester)
      await typed.locator('select').first().selectOption({ label: 'Protocolo' })
      await typed.locator('textarea').fill('Nota interna da equipe')
      await typed.locator('.warehouse-cart-row select').selectOption({ label: 'Papel A4 (Unidade)' })
      await typed.locator('.warehouse-cart-row input').first().fill('1')
      await typed.locator('button[type=submit]').click()
      await admin.waitForSelector('.warehouse-request-page')
      const typedPath = new URL(admin.url()).pathname
      await slm.goto(typedPath)
      await slm.waitForSelector('.warehouse-request-page')
      const typedForecast = slm.locator('.detail-action', { has: slm.locator('h3', { hasText: 'previsão de entrega' }) })
      await typedForecast.locator('input[type=date]').fill('2031-04-15')
      await typedForecast.locator('button[type=submit]').click()
      await slm.locator('[role=status]', { hasText: 'O solicitante será avisado' }).waitFor()
      await slm.locator('[aria-label="Comunicações do pedido"]', { hasText: 'Previsão de entrega' }).waitFor()

      await requester.goto(typedPath)
      await requester.waitForSelector('.warehouse-request-page')
      const followUp = await requester.textContent('.warehouse-request-page')
      assert.ok(followUp.includes('15/04/2031'))
      assert.ok(followUp.includes('Papel A4'))
      for (const hidden of ['Nota interna da equipe', 'Dados do pedido', 'Histórico', 'Documentos e anexos', 'Comunicações']) {
        assert.ok(!followUp.includes(hidden), `o solicitante não deveria ver: ${hidden}`)
      }
    })

    await step('conferência de inventário calcula a diferença', async () => {
      await admin.goto('/almoxarifado')
      await admin.locator('.module-tabs a', { hasText: 'Inventário' }).click()
      const form = admin.locator('.detail-action')
      await form.locator('input').first().fill('Conferência E2E')
      await form.locator('input[type=date]').fill('2031-01-31')
      await form.locator('input[type=number]').fill('10')
      await form.locator('button[type=submit]').click()
      await admin.locator('[aria-label="Contagem de Papel A4"]').fill('8')
      await admin.locator('button:has-text("Salvar")').click()
      await admin.locator('td', { hasText: 'Divergente' }).waitFor()
      assert.ok((await admin.textContent('.data-table tbody')).includes('-2'))
      await admin.click('button:has-text("Concluir conferência")')
      await admin.locator('.detail-status', { hasText: 'Concluída' }).waitFor()
    })

    await step('formulários: o campo criado vale em outro navegador', async () => {
      await admin.goto('/configuracoes?aba=formularios')
      await admin.locator('summary', { hasText: 'Abrir gerenciador de formulários' }).click()
      const customize = admin.locator('[data-testid=form-editor]')
      await customize.waitFor()
      await customize.locator('button', { hasText: /Adicionar campo/ }).click()
      const field = customize.locator('details[data-field^=custom-]').last()
      await field.locator('summary').click()
      await field.locator('label', { hasText: 'Nome' }).first().locator('input').fill('Ramal de contato')
      await customize.locator('button', { hasText: 'Publicar' }).click()
      await customize.locator('.ui-alert-success', { hasText: 'publicado' }).waitFor()

      // A solicitante está em outra sessão, sem nada guardado no navegador sobre isso.
      await requester.goto('/manutencao/nova')
      await requester.locator('label', { hasText: 'Ramal de contato' }).first().waitFor()
    })

    await step('passagens: os filtros suspensos atualizam a lista e podem ser limpos', async () => {
      await requester.goto('/passagens-aereas')
      await requester.waitForSelector('.maintenance-table tbody tr')
      const statusFilter = requester.locator('.ui-filter-field', { hasText: 'Situação' }).locator('select')
      assert.ok((await statusFilter.locator('option').allTextContents()).includes('Em cotação'))
      const tripFilter = requester.locator('.ui-filter-field', { hasText: 'Tipo de viagem' }).locator('select')
      assert.ok((await tripFilter.locator('option').allTextContents()).includes('Somente volta'))
      assert.equal(await requester.locator('.ui-filter-bar button[aria-pressed]').count(), 0)

      await statusFilter.selectOption({ label: 'Emitida' })
      await requester.locator('.ui-empty').waitFor()
      await requester.click('.ui-clear-filters')
      await requester.waitForSelector('.maintenance-table tbody tr')
      assert.equal(await statusFilter.inputValue(), '')

      await statusFilter.selectOption({ label: 'Aguardando aprovação' })
      await requester.waitForFunction(() => document.querySelectorAll('.maintenance-table tbody tr').length === 1)
      const period = requester.locator('.ui-filter-field', { hasText: 'Período' }).locator('select')
      await period.selectOption({ label: 'Personalizado' })
      await requester.locator('.ui-filter-field', { hasText: 'De' }).locator('input[type=date]').fill('2000-01-01')
      await requester.locator('.ui-filter-field', { hasText: 'Até' }).locator('input[type=date]').fill('2000-12-31')
      await requester.locator('.ui-empty').waitFor()
    })

    await step('Dashboard é separado da tela inicial e usa dados reais', async () => {
      await requester.goto('/dashboard')
      await requester.waitForSelector('.ui-metric')
      assert.equal(await requester.locator('.nav-item.active .nav-label').textContent(), 'Dashboard')
      assert.equal(await requester.locator('.recent-table').count(), 0)
      await requester.waitForSelector('.ui-column')
      await requester.waitForSelector('.report-bar')
      const firstMetric = await requester.locator('.ui-metric-value').first().textContent()
      assert.equal(firstMetric, '3', 'três solicitações da própria pessoa')

      await requester.locator('.ui-filter-field', { hasText: 'Módulo' }).locator('select').selectOption('fleet')
      await requester.waitForFunction(() => document.querySelector('.ui-metric-value')?.textContent === '1')

      await requester.goto('/entrar')
      await requester.waitForSelector('.recent-table')
      assert.equal(await requester.locator('.module-card').count(), 0)
    })

    await step('painel, relatórios e auditoria mostram os dados reais', async () => {
      await requester.goto('/entrar')
      await requester.waitForSelector('.recent-table a')
      const recent = await requester.locator('.recent-table a').count()
      assert.equal(recent, 3, 'solicitante vê só as próprias solicitações')

      await operator.goto('/relatorios')
      await operator.waitForSelector('.report-bar')

      await admin.goto('/auditoria')
      await admin.selectOption('.module-filters select >> nth=0', 'request.')
      await admin.locator('td', { hasText: 'Solicitação criada' }).first().waitFor()
      await admin.selectOption('.module-filters select >> nth=0', 'flights.')
      const cpfRow = admin.locator('.audit-table tbody tr', { hasText: 'CPF completo consultado' }).first()
      await cpfRow.waitFor()
      assert.match(await cpfRow.getAttribute('class'), /audit-row-important/)
      await cpfRow.locator('button').click()
      await admin.locator('.audit-details').waitFor()
      assert.ok(!(await admin.textContent('.data-table')).includes('00000000191'))
      // Somente consulta: nenhuma ação de edição ou exclusão na tela.
      assert.equal(await admin.locator('.audit-page button:has-text("Excluir"), .audit-page button:has-text("Editar")').count(), 0)
    })

    await step('minha conta: encerrar as outras sessões derruba o outro acesso', async () => {
      const second = await login(emails.requester)
      await requester.goto('/minha-conta')
      await requester.waitForSelector('.data-table')
      await requester.click('button:has-text("Encerrar as outras sessões")')
      await requester.locator('[role=status]', { hasText: 'encerrada' }).waitFor()
      await second.reload()
      // No endereço principal, sem sessão, aparece a página inicial pública (com o botão Entrar).
      await second.waitForSelector('#login-identifier, .public-hero')
      assert.equal(await second.locator('.topbar-logout').count(), 0)
    })

    assert.deepEqual(violations, [], 'toda resposta veio do backend desta execução')
    assert.deepEqual(pageErrors, [], 'sem erros de JavaScript nas páginas')
    console.log('✔ módulos: toda resposta veio do backend desta execução, sem erros de página')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
