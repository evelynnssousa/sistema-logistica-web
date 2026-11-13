/**
 * Controle de Demandas no navegador: configuração, cadastro, recorrência, colaboração, quadro, agenda,
 * relatórios e permissões. Executado somente por scripts/run-browser-tests.cjs, em banco descartável.
 */
const assert = require('node:assert/strict')
const { join } = require('node:path')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const emails = {
  lead: 'e2e-demanda-lider@slm-e2e.invalid',
  member: 'e2e-demanda-membro@slm-e2e.invalid',
  other: 'e2e-demanda-outro@slm-e2e.invalid',
  manager: 'e2e-demanda-gestor@slm-e2e.invalid',
  outsider: 'e2e-demanda-fora@slm-e2e.invalid',
}
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

async function run({ playwright, baseUrl, runId, password, screenshotDirectory }) {
  // Muitas sessões ao mesmo tempo: em contêiner, o /dev/shm pequeno derruba as páginas.
  const browser = await playwright.chromium.launch({ args: ['--disable-dev-shm-usage'] })
  try {
    await scenarios({ browser, baseUrl, runId, password, screenshotDirectory })
  } finally {
    await browser.close()
  }
}

async function scenarios({ browser, baseUrl, runId, password, screenshotDirectory }) {
  const origin = new URL(baseUrl).origin
  const violations = []
  const pageErrors = []
  const contexts = []

  async function login(email, viewport = { width: 1360, height: 900 }) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport, acceptDownloads: true })
    contexts.push(context)
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
        return { status: response.status, body: await response.json().catch(() => null) }
      },
      { method, path, body },
    )

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  async function shot(page, name) {
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `demandas-${name}.png`), fullPage: true })
  }

  async function assertNoSideScroll(page, label) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `rolagem lateral em ${label}: ${overflow}px`)
  }

  const nameFrom = (email) => `Pessoa ${email.split('@')[0].replace('e2e-demanda-', '')}`
  const today = new Date().toISOString().slice(0, 10)
  const plusDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

  const admin = await login(adminEmail)
  const users = {}
  const anonymous = await browser.newContext({ baseURL: baseUrl })
  const anonymousPage = await anonymous.newPage()
  for (const email of Object.values(emails)) {
    const registered = await anonymousPage.request.post('/api/auth/register', {
      data: { fullName: nameFrom(email), email, sector: 'Administração', password, passwordConfirmation: password },
    })
    assert.equal(registered.status(), 202)
    const pending = await api(admin, 'GET', '/admin/registrations/pending')
    const pendingId = pending.body.registrations.find((item) => item.email === email).id
    assert.equal((await api(admin, 'POST', `/admin/registrations/${pendingId}/approve`, { role: 'requester' })).status, 200)
    users[email] = pendingId
  }
  await anonymous.close()

  await step('o administrador configura setores e integrantes em Configurações', async () => {
    await admin.goto('/configuracoes?aba=demandas')
    await admin.waitForSelector('#settings-demands')
    await admin.fill('input[placeholder="Nome do novo setor"]', 'Setor E2E Alfa')
    await admin.click('button:has-text("Cadastrar setor")')
    await admin.waitForSelector('.demand-settings-card h3:has-text("Setor E2E Alfa")')
    await admin.fill('input[placeholder="Nome do novo setor"]', 'Setor E2E Beta')
    await admin.click('button:has-text("Cadastrar setor")')
    await admin.waitForSelector('.demand-settings-card h3:has-text("Setor E2E Beta")')

    const card = admin.locator('.demand-settings-card', { hasText: 'Setor E2E Alfa' })
    await card.locator('input[placeholder^="Pesquisar conta"]').fill('demanda-lider')
    await card.locator('button:has-text("Pesquisar")').click()
    await card.locator('button:has-text("Incluir")').first().click()
    await card.locator('tr', { hasText: nameFrom(emails.lead) }).waitFor()
    await card.locator('tr', { hasText: nameFrom(emails.lead) }).locator('select').selectOption('chefia')
    await admin.waitForSelector('.ui-alert-success')
    await shot(admin, 'configuracoes')

    const sectors = (await api(admin, 'GET', '/demands/settings/sectors')).body.sectors
    const alfa = sectors.find((item) => item.name === 'Setor E2E Alfa')
    const beta = sectors.find((item) => item.name === 'Setor E2E Beta')
    assert.equal(alfa.members[0].role, 'responsavel')
    assert.equal((await api(admin, 'PUT', `/demands/settings/sectors/${alfa.id}/members/${users[emails.member]}`, { role: 'colaborador' })).status, 200)
    assert.equal((await api(admin, 'PUT', `/demands/settings/sectors/${beta.id}/members/${users[emails.other]}`, { role: 'responsavel' })).status, 200)
    const access = await api(admin, 'PUT', `/admin/users/${users[emails.manager]}/access`, {
      role: 'requester', slmMember: false, grantedPermissions: ['demands:directorate'], deniedPermissions: [],
    })
    assert.equal(access.status, 200)

    // Administrar não depende de integrar um setor.
    await admin.goto('/entrar')
    await admin.waitForSelector('.navigation a[href="/demandas"]')
    assert.equal((await api(admin, 'GET', '/demands')).status, 200)
    assert.equal((await api(admin, 'POST', '/demands', { title: 'Sem vínculo' })).status, 403, 'consulta, sem cadastrar')
  })

  const lead = await login(emails.lead)
  const member = await login(emails.member)
  const other = await login(emails.other)
  const manager = await login(emails.manager)
  const outsider = await login(emails.outsider)

  await step('o módulo só aparece para quem integra um setor ou é gestor, e a API confirma', async () => {
    for (const page of [lead, member, other, manager]) {
      await page.waitForSelector('.navigation a[href="/demandas"]')
    }
    assert.equal(await outsider.locator('.navigation a[href="/demandas"]').count(), 0)
    await outsider.goto('/demandas')
    await outsider.waitForSelector('text=Acesso não autorizado')
    assert.equal((await api(outsider, 'GET', '/demands')).status, 403)
    assert.equal((await api(outsider, 'POST', '/demands', { title: 'Invasão' })).status, 403)
  })

  let demandId = ''
  await step('cria uma demanda compartilhada pelo formulário, com colaborador e anexo', async () => {
    await lead.goto('/demandas/nova')
    await lead.waitForSelector('.demand-form')
    const form = lead.locator('.demand-form')
    await form.getByLabel('Título').fill('Levantamento de contratos E2E')
    await form.getByLabel('Descrição detalhada').fill('Depende de informações do outro setor.')
    await form.getByLabel('Categoria').selectOption({ label: 'Levantamentos' })
    await form.getByLabel('Setor de origem').selectOption({ label: 'Setor E2E Alfa' })
    await form.getByLabel('Setor responsável').selectOption({ label: 'Setor E2E Alfa' })
    await form.getByLabel('Responsável principal').selectOption({ label: nameFrom(emails.member) })
    await form.getByRole('checkbox', { name: 'Setor E2E Beta' }).check()
    await form.getByRole('button', { name: 'Adicionar colaborador' }).click()
    await form.locator('.demand-collaborator-row select').selectOption({ label: nameFrom(emails.other) })
    await form.locator('.demand-collaborator-row').getByLabel('Atividade', { exact: true }).fill('Enviar os dados')
    await form.getByLabel('Prazo para conclusão').fill(plusDays(2))
    await form.getByLabel('Prioridade').selectOption('alta')
    await form.locator('input[type="file"]').setInputFiles({ name: 'contratos.pdf', mimeType: 'application/pdf', buffer: pdf })
    await shot(lead, 'formulario')
    await form.getByRole('button', { name: 'Cadastrar demanda' }).click()
    await lead.waitForURL(/\/demandas\/[0-9a-f-]{36}$/)
    demandId = lead.url().split('/').pop()
    await lead.waitForSelector('h1:has-text("Levantamento de contratos E2E")')
    await lead.waitForSelector('.demand-attachments >> text=contratos.pdf')
    await lead.waitForSelector('text=Enviar os dados')
    await lead.waitForSelector('.demand-history >> text=Demanda criada')
    await lead.waitForSelector('text=DEM-')
    await shot(lead, 'detalhe')
  })

  await step('o servidor recebe a notificação; o chefe registra comentário com menção', async () => {
    const notices = (await api(member, 'GET', '/notifications')).body.notifications
    assert.ok(notices.some((item) => item.link === `/demandas/${demandId}`))
    await member.goto(`/demandas/${demandId}`)
    await member.waitForSelector('#demand-comments')
    await lead.goto(`/demandas/${demandId}`)
    await lead.waitForSelector('#demand-comments')
    await lead.getByLabel('Tipo de registro').selectOption('providencia')
    await lead.getByLabel('Mencionar').selectOption({ label: nameFrom(emails.member) })
    await lead.getByLabel('Texto', { exact: true }).fill('Solicitei os contratos.')
    await lead.getByRole('button', { name: 'Registrar' }).click()
    await lead.waitForSelector('.demand-comments >> text=Solicitei os contratos.')
    await lead.waitForSelector('.demand-comments >> text=Providência')
  })

  await step('altera o status exigindo quem é aguardado, cria etapas e impede a conclusão com etapa aberta', async () => {
    await lead.getByRole('button', { name: 'Alterar status' }).click()
    await lead.getByLabel('Novo status').selectOption('aguardando_terceiros')
    await lead.getByLabel('Quem ou qual instituição está sendo aguardada').fill('Fornecedor Fictício')
    await lead.getByRole('button', { name: 'Salvar status' }).click()
    await lead.waitForSelector('.demand-summary >> text=Fornecedor Fictício')

    await lead.getByRole('button', { name: 'Nova etapa' }).click()
    await lead.locator('.ui-modal').getByLabel('Título').fill('Coletar contratos')
    await lead.locator('.ui-modal').getByLabel('Responsável').selectOption({ label: nameFrom(emails.member) })
    await lead.getByRole('button', { name: 'Criar etapa' }).click()
    await lead.waitForSelector('.demand-subtasks >> text=Coletar contratos')

    // P-15: o anexo pode ser vinculado a uma etapa pela tela, e a lista mostra a etapa.
    await lead.getByLabel('Etapa do anexo (opcional)').selectOption({ label: 'Coletar contratos' })
    await lead.locator('section[aria-labelledby="demand-attachments"] input[type="file"]')
      .setInputFiles({ name: 'contrato-etapa.pdf', mimeType: 'application/pdf', buffer: pdf })
    await lead.waitForSelector('.demand-attachments li:has-text("contrato-etapa.pdf") >> text=Etapa: Coletar contratos')
    const linked = (await api(lead, 'GET', `/demands/${demandId}`)).body.attachments
      .find((item) => item.name === 'contrato-etapa.pdf')
    const stepId = (await api(lead, 'GET', `/demands/${demandId}`)).body.subtasks
      .find((item) => item.title === 'Coletar contratos').id
    assert.equal(linked.subtaskId, stepId)

    await lead.getByRole('button', { name: 'Concluir' }).first().click()
    await lead.locator('.ui-modal').getByLabel('O que foi realizado').fill('Tudo entregue')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Concluir' }).click()
    await lead.waitForSelector('.ui-modal >> text=etapa(s) em aberto')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Voltar' }).click()

    await lead.getByLabel('Status de Coletar contratos').selectOption('concluida')
    await lead.waitForSelector('.demand-progress >> text=100%')
    await lead.waitForSelector('.demand-summary >> text=Aguardando terceiros')
  })

  await step('conclui, reabre com justificativa e preserva o histórico', async () => {
    await lead.getByRole('button', { name: 'Concluir' }).first().click()
    await lead.locator('.ui-modal').getByLabel('O que foi realizado').fill('Levantamento entregue')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Concluir' }).click()
    await lead.waitForSelector('text=Levantamento entregue')
    await lead.getByRole('button', { name: 'Reabrir' }).click()
    await lead.locator('.ui-modal').getByLabel('Justificativa').fill('Faltou um contrato')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Reabrir' }).click()
    await lead.waitForSelector('.demand-history >> text=Demanda reaberta')
    await lead.waitForSelector('.demand-history >> text=Demanda concluída')
    await lead.waitForSelector('.demand-history >> text=Faltou um contrato')
  })

  await step('quem é de setor colaborador também edita; o chefe do setor reatribui', async () => {
    await other.goto(`/demandas/${demandId}`)
    await other.getByRole('button', { name: 'Distribuir' }).waitFor()
    assert.equal(await other.locator('text=Modo de consulta').count(), 0)
    await lead.goto(`/demandas/${demandId}`)
    await lead.getByRole('button', { name: 'Distribuir' }).click()
    await lead.locator('.ui-modal').getByLabel('Responsável principal').selectOption({ label: nameFrom(emails.lead) })
    await lead.getByRole('button', { name: 'Salvar responsável' }).click()
    await lead.waitForSelector('.demand-history >> text=Responsável alterado')
    // O registro mostra quem saiu, quem entrou e quem fez a alteração.
    const entry = lead.locator('.demand-history li', { hasText: 'Responsável alterado' }).last()
    await entry.locator('dt', { hasText: 'Anterior:' }).waitFor()
    await entry.locator('dd', { hasText: nameFrom(emails.lead) }).waitFor()
    await entry.locator('text=Realizado por').waitFor()
  })

  let seriesDemand = ''
  await step('cria uma recorrência mensal com duas datas e gerencia a série pela tela', async () => {
    await lead.goto('/demandas/nova')
    const form = lead.locator('.demand-form')
    await form.getByLabel('Título').fill('Pagamento do RH E2E')
    await form.getByLabel('Descrição detalhada').fill('Conferência dos pagamentos.')
    await form.getByLabel('Categoria').selectOption({ label: 'Atividades periódicas' })
    await form.getByLabel('Setor de origem').selectOption({ label: 'Setor E2E Alfa' })
    await form.getByLabel('Setor responsável').selectOption({ label: 'Setor E2E Alfa' })
    await form.getByLabel('Repetir a demanda', { exact: true }).check()
    await form.getByLabel('Repetir a demanda a cada').selectOption('mensal')
    await form.getByLabel('Dias do mês').fill('5, 20')
    await form.getByLabel('Encerramento').selectOption('quantidade')
    await form.getByRole('spinbutton', { name: 'Quantidade de ocorrências' }).fill('6')
    await shot(lead, 'recorrencia')
    await form.getByRole('button', { name: 'Cadastrar demanda' }).click()
    await lead.waitForURL(/\/demandas\/[0-9a-f-]{36}$/)
    seriesDemand = lead.url().split('/').pop()
    await lead.waitForSelector('#demand-series')
    await lead.waitForSelector('text=A cada mês, dias 5 e 20')
    await lead.waitForSelector('text=Próximas datas previstas')

    const dates = (await api(lead, 'GET', `/demands/${seriesDemand}`)).body
    assert.ok(['05', '20'].includes(dates.demand.dueDate.slice(8, 10)))
    assert.equal(dates.series.upcoming.length, 5)

    await lead.getByRole('button', { name: 'Suspender' }).click()
    await lead.locator('.ui-modal').getByLabel('Justificativa').fill('Férias do setor')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Suspender' }).click()
    await lead.waitForSelector('#demand-series ~ * >> text=Suspensa', { state: 'attached' }).catch(() => undefined)
    await lead.waitForSelector('.demand-flag:has-text("Suspensa")')
    await lead.getByRole('button', { name: 'Retomar' }).click()
    await lead.waitForSelector('.demand-flag:has-text("Ativa")')
    await lead.waitForSelector('.demand-history >> text=Recorrência retomada')

    await lead.getByRole('button', { name: 'Pular uma data' }).click()
    await lead.locator('.ui-modal').getByLabel('Data').selectOption({ index: 1 })
    await lead.locator('.ui-modal').getByLabel('Motivo').fill('Feriado')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Pular' }).click()
    await lead.waitForSelector('.demand-history >> text=Ocorrência pulada')
    await shot(lead, 'serie')
  })

  await step('quadro: mover pelo controle exige os dados necessários, e o servidor recusa quem não administra', async () => {
    await lead.goto('/demandas/todas')
    await lead.getByRole('button', { name: 'Quadro' }).click()
    await lead.waitForSelector('.demand-kanban')
    const card = lead.locator('.demand-card', { hasText: 'Pagamento do RH E2E' })
    const select = card.locator('select')
    await select.selectOption('em_andamento')
    await lead.locator('.demand-kanban-column[aria-label="Em andamento"] .demand-card', { hasText: 'Pagamento do RH E2E' }).waitFor()
    await lead.locator('.demand-card', { hasText: 'Pagamento do RH E2E' }).locator('select').selectOption('suspensa')
    await lead.locator('.ui-modal').getByLabel('Justificativa da suspensão').fill('Aguardando definição')
    await lead.locator('.ui-modal').getByRole('button', { name: 'Confirmar' }).click()
    await lead.locator('.demand-kanban-column[aria-label="Suspensa"] .demand-card', { hasText: 'Pagamento do RH E2E' }).waitFor()
    await shot(lead, 'quadro')
    await lead.locator('.demand-card', { hasText: 'Pagamento do RH E2E' }).locator('select').selectOption('em_andamento')
    assert.equal((await api(other, 'POST', `/demands/${seriesDemand}/status`, { status: 'nao_iniciada' })).status, 404)
  })

  await step('filtros e visualização em lista funcionam juntos', async () => {
    await lead.getByRole('button', { name: 'Lista' }).click()
    await lead.getByRole('searchbox', { name: 'Título e descrição', exact: true }).fill('Levantamento de contratos')
    await lead.waitForFunction(() => document.querySelectorAll('.demand-table tbody tr').length === 1)
    await lead.getByRole('button', { name: 'Mais filtros' }).click()
    await lead.getByLabel('Recorrente').selectOption('true')
    await lead.waitForSelector('text=Nenhuma demanda encontrada')
    await lead.getByRole('button', { name: 'Limpar filtros' }).click()
    await lead.waitForSelector('.demand-table >> text=Pagamento do RH E2E')
    await member.goto('/demandas/minhas')
    await member.waitForSelector('text=Nenhuma demanda encontrada').catch(() => undefined)
  })

  await step('demanda restrita não aparece para o servidor nem para outros setores, em nenhuma tela ou rota; o diretor a vê', async () => {
    const created = await api(lead, 'POST', '/demands', {
      title: 'Apuração sigilosa E2E',
      description: 'Conteúdo restrito.',
      categoryId: (await api(lead, 'GET', '/demands/options')).body.categories[0].id,
      originSectorId: (await api(lead, 'GET', '/demands/context')).body.memberships[0].sectorId,
      responsibleSectorId: (await api(lead, 'GET', '/demands/context')).body.memberships[0].sectorId,
      restricted: true,
      dueDate: plusDays(1),
    })
    assert.equal(created.status, 201)
    for (const page of [member, other]) {
      assert.equal((await api(page, 'GET', `/demands/${created.body.id}`)).status, 404)
      const list = await api(page, 'GET', '/demands?pageSize=200')
      assert.ok(!JSON.stringify(list.body).includes('Apuração sigilosa'))
      assert.ok(!JSON.stringify((await api(page, 'GET', '/demands/dashboard')).body).includes('Apuração sigilosa'))
      assert.ok(!JSON.stringify((await api(page, 'GET', `/demands/agenda?from=${today}&to=${plusDays(5)}`)).body).includes('Apuração sigilosa'))
    }
    await manager.goto(`/demandas/${created.body.id}`)
    await manager.waitForSelector('h1:has-text("Apuração sigilosa E2E")')
    await lead.goto(`/demandas/${created.body.id}`)
    await lead.waitForSelector('h1:has-text("Apuração sigilosa E2E")')
    await lead.waitForSelector('.demand-flag:has-text("Restrita")')
  })

  await step('painel com dados reais; o diretor vê e edita todos os setores', async () => {
    await manager.goto('/demandas')
    await manager.waitForSelector('.ui-metrics')
    await manager.waitForSelector('text=Visão de todos os setores')
    const data = (await api(manager, 'GET', '/demands/dashboard')).body
    assert.ok(data.totals.abertas >= 2)
    const value = await manager.locator('.ui-metric', { hasText: 'Demandas abertas' }).locator('.ui-metric-value').innerText()
    assert.equal(value, String(data.totals.abertas))
    assert.ok(data.bySector.some((item) => item.label === 'Setor E2E Alfa'))
    await manager.waitForSelector('.navigation a[href="/demandas"]')
    await shot(manager, 'painel')

    await manager.goto(`/demandas/${demandId}`)
    await manager.getByRole('button', { name: 'Alterar status' }).waitFor()
    assert.equal((await api(manager, 'PATCH', `/demands/${demandId}`, { priority: 'urgente' })).status, 200)
    await manager.locator('a:has-text("Nova demanda")').waitFor()
    // O integrante do outro setor continua sem acesso.
    const alpha = (await api(lead, 'GET', '/demands?pageSize=200')).body.demands.find((item) => item.title === 'Pagamento do RH E2E')
    assert.equal((await api(other, 'GET', `/demands/${alpha.id}`)).status, 404)
  })

  await step('agenda em mês, semana e dia, com prazos, previsão de recorrências e compromissos', async () => {
    await lead.goto('/demandas/agenda')
    await lead.waitForSelector('.demand-month')
    await lead.waitForSelector('.demand-agenda-chip >> text=Levantamento de contratos E2E')
    await lead.getByRole('button', { name: 'Novo compromisso' }).click()
    await lead.locator('.ui-modal').getByLabel('Título').fill('Reunião E2E')
    await lead.locator('.ui-modal').getByLabel('Início').fill(`${today}T15:00`)
    await lead.locator('.ui-modal').getByRole('button', { name: 'Criar compromisso' }).click()
    await lead.waitForSelector('.demand-agenda-chip >> text=Reunião E2E')
    await shot(lead, 'agenda')
    await lead.locator('.demand-agenda-chip', { hasText: 'Reunião E2E' }).click()
    await lead.waitForSelector('.ui-modal >> text=Cancelar compromisso')
    await lead.locator('.ui-modal-close').click()
    await lead.getByRole('button', { name: 'Semana' }).click()
    await lead.waitForSelector('.demand-agenda-list, .ui-empty')
    await lead.getByRole('button', { name: 'Dia', exact: true }).click()
    await lead.waitForSelector('.demand-agenda-list >> text=Reunião E2E')
  })

  await step('relatórios para quem administra, com exportação em PDF e Excel; colaborador não abre', async () => {
    await manager.goto('/demandas/relatorios')
    await manager.waitForSelector('.ui-metrics')
    await manager.waitForSelector('text=não são instrumento de avaliação individual')
    await shot(manager, 'relatorios')
    for (const [text, signature] of [['Exportar em PDF', '%PDF'], ['Exportar em Excel', 'PK']]) {
      const [download] = await Promise.all([manager.waitForEvent('download'), manager.click(`a:has-text("${text}")`)])
      const chunks = []
      for await (const chunk of await download.createReadStream()) chunks.push(chunk)
      assert.equal(Buffer.concat(chunks).toString('latin1', 0, signature.length), signature, text)
    }
    assert.equal((await api(member, 'GET', '/demands/reports')).status, 403)
    await member.goto('/demandas')
    await member.waitForSelector('.module-tabs')
    assert.equal(await member.locator('.module-tabs a[href="/demandas/relatorios"]').count(), 0)
  })

  await step('a aprovação pela tela define lotação, DA, setor e função, e a pessoa já entra no módulo', async () => {
    const email = 'e2e-demanda-aprovada@slm-e2e.invalid'
    const visitor = await browser.newContext({ baseURL: baseUrl })
    const visitorPage = await visitor.newPage()
    const registered = await visitorPage.request.post('/api/auth/register', {
      data: { fullName: 'Pessoa aprovada', email, sector: 'Protocolo', password, passwordConfirmation: password },
    })
    assert.equal(registered.status(), 202)
    await visitor.close()

    await admin.goto('/cadastros-pendentes')
    const row = admin.locator('tr', { hasText: email })
    await row.getByRole('button', { name: 'Definir vínculos' }).click()
    const dialog = admin.locator('.ui-modal')
    await dialog.getByLabel('Setor de lotação').fill('Contabilidade')
    await dialog.getByRole('checkbox', { name: /^Diretor:/ }).check()
    await dialog.getByLabel('Função exercida').fill('Analista')
    await dialog.getByRole('checkbox', { name: 'Setor E2E Beta' }).check()
    await dialog.getByLabel('Papel em Setor E2E Beta').selectOption('chefia')
    await shot(admin, 'aprovacao')
    await dialog.getByRole('button', { name: 'Usar estes vínculos' }).click()
    await row.locator('text=DA').first().waitFor()
    await row.getByRole('button', { name: 'Aprovar' }).click()
    await admin.locator('.ui-modal').getByRole('button', { name: /Aprovar|Confirmar/ }).click()
    await admin.waitForSelector(`text=Cadastro de Pessoa aprovada aprovado`)

    const approved = await login(email)
    await approved.waitForSelector('.navigation a[href="/demandas"]')
    const context = (await api(approved, 'GET', '/demands/context')).body
    assert.equal(context.directorate, true)
    assert.equal(context.memberships[0].role, 'responsavel')
    assert.equal(context.createAnywhere, true)
    await approved.goto('/demandas/nova')
    await approved.waitForSelector('.demand-form')
    await approved.locator('.demand-form').getByLabel('Setor de origem').selectOption({ label: 'Setor E2E Alfa' })

    const users = (await api(admin, 'GET', `/admin/users?search=${encodeURIComponent(email)}`)).body.users
    await admin.goto(`/usuarios/${users[0].id}?aba=historico`)
    await admin.waitForSelector('text=Vínculo institucional alterado')
    await admin.goto(`/usuarios/${users[0].id}?aba=vinculos`)
    await admin.waitForSelector('h2:has-text("Vínculos institucionais")')
    await shot(admin, 'usuario-vinculos')
    await admin.getByRole('checkbox', { name: 'Setor E2E Beta' }).uncheck()
    await admin.getByRole('button', { name: 'Salvar vínculos' }).click()
    await admin.waitForSelector('text=Vínculos atualizados')
    const after = (await api(approved, 'GET', '/demands/context')).body
    assert.equal(after.memberships.length, 0, 'retirada do setor')
    assert.equal(after.hasAccess, true, 'continua como Diretor')
  })

  await step('o administrador consulta uma demanda restrita, sem alterar, e a consulta fica registrada', async () => {
    const list = (await api(admin, 'GET', `/demands?q=${encodeURIComponent('Apuração sigilosa')}`)).body.demands
    assert.equal(list.length, 1)
    await admin.goto(`/demandas/${list[0].id}`)
    await admin.waitForSelector('text=Esta consulta fica registrada na auditoria')
    assert.equal(await admin.getByRole('button', { name: 'Alterar status' }).count(), 0)
    assert.equal(await admin.getByRole('button', { name: 'Registrar' }).count(), 0)
    assert.equal((await api(admin, 'POST', `/demands/${list[0].id}/status`, { status: 'em_andamento' })).status, 403)
    assert.equal((await api(outsider, 'GET', `/demands/${list[0].id}`)).status, 403)
  })

  await step('o que foi gravado continua ao sair e entrar de novo', async () => {
    const again = await login(emails.member)
    await again.goto(`/demandas/${demandId}`)
    await again.waitForSelector('.demand-comments >> text=Solicitei os contratos.')
    await again.waitForSelector('.demand-history >> text=Demanda reaberta')
  })

  await step('atas e contratos: cadastro pela tela, item, utilização e saldo', async () => {
    await lead.goto('/demandas/atas')
    await lead.waitForSelector('text=Nenhuma ata ou contrato encontrado')
    await lead.getByRole('link', { name: 'Nova ata ou contrato' }).click()
    await lead.waitForSelector('#instrument-form-title')
    await lead.getByLabel('Número *').fill('E2E-1/2026')
    await lead.getByLabel('Objeto *').fill('Registro de preços de papel para a Diretoria')
    await lead.getByLabel('Fornecedor').fill('Papelaria Fictícia')
    await lead.getByLabel('Valor total (R$) *').fill('1000')
    await lead.getByLabel('Início da vigência').fill(plusDays(-2))
    await lead.getByLabel('Fim da vigência').fill(plusDays(30))
    await shot(lead, 'ata-formulario')
    await lead.getByRole('button', { name: 'Salvar' }).click()
    await lead.waitForSelector('#instrument-title')
    await lead.waitForSelector('text=Vence em')
    await lead.getByRole('button', { name: 'Novo item' }).click()
    const itemDialog = lead.locator('.ui-modal')
    await itemDialog.getByLabel('Descrição *').fill('Papel A4')
    await itemDialog.getByLabel('Unidade (ex.: resma, hora, vaga) *').fill('resma')
    await itemDialog.getByLabel('Quantidade registrada *').fill('40')
    await itemDialog.getByLabel('Valor unitário (R$) *').fill('25')
    await itemDialog.getByRole('button', { name: 'Salvar' }).click()
    await lead.waitForSelector('text=Item salvo.')
    await lead.getByRole('region', { name: 'Utilizações' }).getByRole('button', { name: 'Registrar utilização' }).click()
    const usageDialog = lead.locator('.ui-modal')
    await usageDialog.getByLabel('Quantidade *').fill('10')
    await usageDialog.getByLabel('Documento (empenho, pedido, ordem de serviço)').fill('2026NE0001')
    await usageDialog.getByRole('button', { name: 'Registrar' }).click()
    await lead.waitForSelector('text=Utilização registrada.')
    await lead.waitForSelector('text=30 resma')
    await lead.waitForSelector('text=2026NE0001')
    await shot(lead, 'ata-detalhe')
    await lead.goto('/demandas/atas')
    await lead.waitForSelector('text=E2E-1/2026')
    await shot(lead, 'atas')
  })

  await step('as telas não têm rolagem lateral em celular', async () => {
    const phone = await login(emails.lead, { width: 390, height: 800 })
    for (const path of ['/demandas', '/demandas/todas', '/demandas/agenda', '/demandas/nova', '/demandas/atas', `/demandas/${seriesDemand}`, '/demandas/relatorios']) {
      await phone.goto(path)
      await phone.waitForSelector('.demands-page')
      await phone.waitForLoadState('networkidle')
      await assertNoSideScroll(phone, path)
    }
    await shot(phone, 'celular')
  })

  await step('uma resposta 401 não prende a tela em novas tentativas', async () => {
    let calls = 0
    const context = lead.context()
    await context.route('**/api/demands/context', async (route) => {
      calls += 1
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: { 'x-slm-e2e-run': runId },
        body: JSON.stringify({ success: false }),
      })
    })
    await lead.goto('/demandas')
    await lead.waitForTimeout(1500)
    await context.unroute('**/api/demands/context')
    assert.ok(calls < 15, `${calls} tentativas em 1,5 segundo`)
    await lead.goto('/entrar')
    await lead.waitForSelector('.topbar-logout')
  })

  await step('os módulos existentes continuam abrindo para quem tem acesso a eles', async () => {
    for (const path of ['/manutencao', '/frota', '/passagens-aereas', '/almoxarifado', '/notificacoes']) {
      await lead.goto(path)
      await lead.waitForSelector('.page-content h1')
    }
    assert.equal((await lead.request.get('/api/health')).status(), 200)
  })

  assert.deepEqual(violations, [], 'uma resposta não veio do backend desta execução')
  assert.deepEqual(pageErrors, [], 'erro de JavaScript em alguma tela')
  for (const context of contexts) await context.close().catch(() => undefined)
}

module.exports = { run }
