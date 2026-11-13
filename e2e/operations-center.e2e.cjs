/**
 * Supercomando 04 no navegador: protocolo, Central da SLM, linha do tempo, anexos, pesquisa,
 * módulos ampliados, parâmetros e monitoramento. Executado somente por
 * scripts/run-browser-tests.cjs, em banco descartável e sem provedores reais.
 */
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { auditPage } = require('./visual-review.e2e.cjs')

const emails = {
  admin: 'e2e-admin@slm-e2e.invalid',
  requester: 'e2e-central-solicitante@slm-e2e.invalid',
  other: 'e2e-central-outra@slm-e2e.invalid',
  operator: 'e2e-central-operadora@slm-e2e.invalid',
}

const viewports = [
  { name: 'computador', width: 1360, height: 900 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'celular', width: 390, height: 844 },
]

async function run({ playwright, baseUrl, runId, password, screenshotDirectory }) {
  const browser = await playwright.chromium.launch()
  const pageErrors = []
  const violations = []
  const baseOrigin = new URL(baseUrl).origin

  async function newPage(viewport = { width: 1360, height: 900 }) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport, acceptDownloads: true })
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
    return page
  }

  async function login(email, viewport) {
    const page = await newPage(viewport)
    await page.goto('/entrar')
    await page.fill('#login-identifier', email)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')
    return page
  }

  async function register(name, email, sector) {
    const page = await newPage()
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
    await page.context().close()
  }

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  /** Chamada à API pela sessão da página, com o token que a própria API devolve. */
  function api(page, method, path, body) {
    return page.evaluate(
      async ({ method, path, body }) => {
        const me = await (await fetch('/api/auth/me', { credentials: 'include' })).json()
        const response = await fetch(`/api${path}`, {
          method,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: response.status, body: await response.json() }
      },
      { method, path, body },
    )
  }

  async function submitForm(page, title, button) {
    const form = page.locator('.management-form', { has: page.locator('h3', { hasText: title }) })
    await form.getByRole('button', { name: button }).click()
    return form
  }

  const fileBuffer = (text) => Buffer.from(text)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

  try {
    const admin = await login(emails.admin)
    await register('Pessoa Solicitante Central', emails.requester, 'Protocolo')
    await register('Outra Pessoa Central', emails.other, 'Protocolo')
    await register('Pessoa Operadora Central', emails.operator, 'CPC')
    await admin.goto('/cadastros-pendentes')
    await admin.waitForSelector('.data-table')
    for (const [email, role] of [
      [emails.requester, 'requester'],
      [emails.other, 'requester'],
      [emails.operator, 'slm_operator'],
    ]) {
      const row = admin.locator('.data-table tbody tr', { hasText: email })
      await row.locator('select').selectOption(role)
      await row.locator('.table-actions button').first().click()
      await admin.click('[data-confirm]')
      await row.waitFor({ state: 'detached' })
    }

    const requester = await login(emails.requester)
    const other = await login(emails.other)
    const operator = await login(emails.operator)

    await step('a Central não aparece nem abre para quem não tem a concessão, nem por ser administrador', async () => {
      for (const page of [admin, requester, operator]) {
        await page.goto('/central-slm')
        await page.waitForFunction(() => !document.querySelector('.ui-loading'))
        assert.equal(await page.locator('.nav-item', { hasText: 'Central SLM' }).count(), 0)
        assert.equal(await page.locator('.central-queues').count(), 0)
      }
      assert.equal((await api(admin, 'GET', '/slm/overview')).status, 403)
    })

    const { body: users } = await api(admin, 'GET', `/admin/users?search=${encodeURIComponent(emails.operator)}`)
    const operatorId = users.users[0].id
    const granted = await api(admin, 'PUT', `/admin/users/${operatorId}/access`, {
      role: 'slm_operator',
      slmMember: true,
      grantedPermissions: ['slm_central:read', 'slm_central:manage', 'requests:schedule'],
      deniedPermissions: [],
    })
    assert.equal(granted.status, 200)

    let protocol
    let detailPath
    await step('a solicitação recebe o protocolo único, e a pesquisa global respeita quem pergunta', async () => {
      await requester.goto('/manutencao/nova')
      await requester.waitForSelector('select[name="andar"] option:not([value=""])', { state: 'attached' })
      await requester.selectOption('select[name="andar"]', { label: '1º andar' })
      await requester.selectOption('select[name="tipoSolicitacao"]', { label: 'Elétrica' })
      await requester.fill('[name="localServico"]', 'Sala E2E Central')
      await requester.fill('[name="descricao"]', 'Defeito para a Central')
      await requester.click('button[type=submit]')
      await requester.waitForSelector('.request-detail-page')
      detailPath = new URL(requester.url()).pathname
      const heading = await requester.locator('.page-content h1').textContent()
      protocol = heading.match(/MAN-\d{4}-\d{5}/)?.[0]
      assert.ok(protocol, `protocolo fora do padrão: ${heading}`)
      assert.ok(!heading.includes('#'))

      await requester.fill('.topbar-search input', protocol)
      await requester.keyboard.press('Enter')
      await requester.waitForSelector('.search-hit')
      await requester.locator('.search-hit').first().click()
      await requester.waitForSelector('.request-detail-page')
      assert.equal(new URL(requester.url()).pathname, detailPath)

      await other.goto(`/pesquisa?q=${protocol}`)
      await other.waitForSelector('.ui-empty')
      assert.equal(await other.locator('.search-hit').count(), 0)
      await other.goto(detailPath)
      await other.waitForSelector('.ui-alert-error')
    })

    await step('a Central mostra as filas, filtra e leva ao histórico da solicitação', async () => {
      await operator.reload()
      await operator.locator('.nav-item', { hasText: 'Central SLM' }).click()
      await operator.waitForSelector('.central-queues')
      const queue = operator.locator('.central-queue', { hasText: 'Sem responsável' })
      const count = Number(await queue.locator('strong').textContent())
      assert.ok(count >= 1)
      await queue.click()
      assert.equal(await queue.getAttribute('aria-pressed'), 'true')
      await operator.fill('.central-page input[type=search]', protocol)
      const row = operator.locator('.central-table tbody tr', { hasText: protocol })
      await row.waitFor()
      assert.ok((await row.textContent()).includes('Sem responsável'))
      await row.locator('a').click()
      await operator.waitForSelector('.request-detail-page')
    })

    await step('atribuição, prioridade e observação pela solicitação, com justificativa na linha do tempo', async () => {
      await operator.locator('.management-details summary').click()
      const assignForm = operator.locator('.management-form', { has: operator.locator('h3', { hasText: 'Responsável' }) })
      await assignForm.locator('select option', { hasText: 'Pessoa Operadora Central' }).waitFor({ state: 'attached' })
      await assignForm.locator('select').selectOption({ label: 'Pessoa Operadora Central' })
      await submitForm(operator, 'Responsável', 'Salvar responsável')
      await operator.locator('.request-timeline li', { hasText: 'Responsável alterado' }).waitFor()

      const priorityForm = operator.locator('.management-form', { has: operator.locator('h3', { hasText: 'Prioridade' }) })
      await priorityForm.locator('select').selectOption('urgente')
      await priorityForm.locator('textarea').fill('Risco elétrico confirmado')
      await submitForm(operator, 'Prioridade', 'Salvar prioridade')
      const entry = operator.locator('.request-timeline li', { hasText: 'Prioridade alterada' })
      await entry.waitFor()
      const text = await entry.textContent()
      assert.ok(text.includes('Risco elétrico confirmado'))
      assert.ok(text.includes('normal → urgente'))

      const noteForm = operator.locator('.management-form', { has: operator.locator('h3', { hasText: 'Nova observação' }) })
      await noteForm.locator('textarea').fill('Observação só da equipe E2E')
      await submitForm(operator, 'Nova observação', 'Registrar observação')
      await operator.locator('.detail-history li', { hasText: 'Observação só da equipe E2E' }).waitFor()

      // Quem solicita acompanha o andamento, sem o contexto interno.
      await requester.goto(detailPath)
      await requester.waitForSelector('.request-timeline')
      const page = await requester.textContent('.page-content')
      assert.ok(!page.includes('Observação só da equipe E2E'))
      assert.ok(!page.includes('Risco elétrico confirmado'))
      assert.equal(await requester.locator('#management-title').count(), 0)
    })

    await step('anexos: arquivo aceito, conteúdo falso recusado, restrito oculto e remoção com justificativa', async () => {
      await requester.goto(detailPath)
      const panel = requester.locator('.attachment-upload')
      await panel.waitFor()
      await panel.locator('input[type=file]').setInputFiles({
        name: 'falso.png',
        mimeType: 'image/png',
        buffer: fileBuffer('isto não é uma imagem'),
      })
      await panel.getByRole('button', { name: 'Enviar documento' }).click()
      await requester.locator('.ui-alert-error', { hasText: 'extensão' }).waitFor()

      await panel.locator('input[type=file]').setInputFiles({ name: 'antes.png', mimeType: 'image/png', buffer: png })
      await panel.locator('select').selectOption('fotografia_antes')
      await panel.getByRole('button', { name: 'Enviar documento' }).click()
      const item = requester.locator('.attachment-item', { hasText: 'antes.png' })
      await item.waitFor()
      assert.ok((await item.textContent()).includes('Fotografia: antes'))

      const download = requester.waitForEvent('download')
      await item.getByRole('link', { name: 'Baixar' }).click()
      assert.equal((await download).suggestedFilename(), 'antes.png')

      await operator.goto(detailPath)
      const staffPanel = operator.locator('.attachment-upload')
      await staffPanel.waitFor()
      await staffPanel.locator('input[type=file]').setInputFiles({ name: 'interno.png', mimeType: 'image/png', buffer: png })
      await staffPanel.locator('.attachment-restricted input').check()
      await staffPanel.getByRole('button', { name: 'Enviar documento' }).click()
      await operator.locator('.attachment-item', { hasText: 'interno.png' }).waitFor()

      await requester.reload()
      await requester.locator('.attachment-item', { hasText: 'antes.png' }).waitFor()
      assert.equal(await requester.locator('.attachment-item', { hasText: 'interno.png' }).count(), 0)

      const removable = operator.locator('.attachment-item', { hasText: 'interno.png' })
      await removable.getByRole('button', { name: 'Remover' }).click()
      const dialog = operator.locator('dialog[open]')
      await dialog.locator('textarea').fill('Enviado por engano')
      await dialog.getByRole('button', { name: 'Remover anexo' }).click()
      await operator.locator('.attachment-item.is-removed', { hasText: 'Enviado por engano' }).waitFor()
      await operator.locator('.request-timeline li', { hasText: 'Anexo removido' }).waitFor()
    })

    await step('notificações: a atribuição a outra pessoa aparece como pendência e leva à solicitação', async () => {
      const id = detailPath.split('/').pop()
      const colleagueEmail = 'e2e-central-colega@slm-e2e.invalid'
      await register('Pessoa Colega Central', colleagueEmail, 'CPC')
      await admin.goto('/cadastros-pendentes')
      const row = admin.locator('.data-table tbody tr', { hasText: colleagueEmail })
      await row.locator('select').selectOption('slm_operator')
      await row.locator('.table-actions button').first().click()
      await admin.click('[data-confirm]')
      await row.waitFor({ state: 'detached' })

      const { body: people } = await api(operator, 'GET', '/operations/assignees')
      const colleague = people.assignees.find((person) => person.name === 'Pessoa Colega Central')
      const transferred = await api(operator, 'POST', `/slm/requests/${id}/assign`, {
        responsavelId: colleague.id,
        justificativa: 'Redistribuição da equipe',
      })
      assert.equal(transferred.status, 200)

      const colleaguePage = await login(colleagueEmail)
      await colleaguePage.goto('/notificacoes')
      await colleaguePage.locator('.ui-filter-bar select').selectOption('pending')
      const item = colleaguePage.locator('.notification-list li', { hasText: 'Solicitação atribuída a você' })
      await item.waitFor()
      assert.ok((await item.textContent()).includes(protocol))
      assert.ok((await item.textContent()).includes('Exige providência'))
      await item.locator('button').click()
      await colleaguePage.waitForSelector('.request-detail-page')
      assert.equal(new URL(colleaguePage.url()).pathname, detailPath)
      await colleaguePage.context().close()
    })

    await step('registro da execução e equipamento opcional', async () => {
      const created = await api(admin, 'POST', '/maintenance/equipments', { nome: 'Quadro de energia', local: 'Subsolo' })
      assert.equal(created.status, 201)
      await operator.goto(detailPath)
      const form = operator.locator('section', { has: operator.locator('#execution-title') }).locator('form')
      await form.waitFor()
      await form.getByLabel('Quem realizou *').fill('Técnico Fictício')
      await form.getByLabel('Data e horário *').fill('2030-01-15T10:00')
      await form.getByLabel('Equipamento (opcional)').selectOption({ label: 'Quadro de energia · Subsolo' })
      await form.getByLabel('Serviço realizado *').fill('Troca do disjuntor')
      await form.getByRole('button', { name: 'Registrar execução' }).click()
      await operator.locator('.detail-history li', { hasText: 'Troca do disjuntor' }).waitFor()
      await operator.goto('/manutencao/equipamentos')
      await operator.locator('.data-table tr', { hasText: 'Quadro de energia' }).getByRole('button', { name: 'Histórico' }).click()
      await operator.locator('dialog[open]').getByText(protocol).waitFor()
    })

    await step('frota: veículo cadastrado, uso registrado e alerta de revisão', async () => {
      await admin.goto('/frota')
      await admin.getByRole('link', { name: 'Veículos' }).click()
      await admin.waitForSelector('#vehicle-new')
      const form = admin.locator('section', { has: admin.locator('#vehicle-new') }).locator('form')
      await form.getByLabel('Placa *').fill('E2E1A23')
      await form.getByLabel('Modelo *').fill('Utilitário')
      await form.getByLabel('Quilometragem atual').fill('1000')
      await form.getByLabel('Próxima revisão (km)').fill('1200')
      await form.getByRole('button', { name: 'Cadastrar veículo' }).click()
      await admin.locator('.data-table a', { hasText: 'E2E1A23' }).click()
      await admin.waitForSelector('#vehicle-record')
      const record = admin.locator('section', { has: admin.locator('#vehicle-record') }).locator('form')
      await record.getByLabel('Data e horário *').fill('2030-02-01T09:00')
      await record.getByLabel('Km inicial *').fill('1000')
      await record.getByLabel('Km final *').fill('1250')
      await record.getByLabel('Descrição *').fill('Viagem ao fórum')
      await record.getByRole('button', { name: 'Registrar' }).click()
      await admin.locator('.data-table td', { hasText: 'Viagem ao fórum' }).waitFor()
      await admin.locator('.ui-alert-error', { hasText: 'Revisão vencida' }).waitFor()
    })

    await step('almoxarifado: saldo interno, mínimo e movimentação com justificativa', async () => {
      await admin.goto('/almoxarifado/materiais')
      await admin.waitForSelector('.page-content h2, .page-content form')
      const created = await api(admin, 'POST', '/warehouse/materials', {
        name: 'Material E2E Estoque',
        unitId: (await api(admin, 'GET', '/catalog')).body.catalog.measurementUnits[0].id,
      })
      assert.equal(created.status, 201)
      await admin.goto('/almoxarifado/estoque')
      const form = admin.locator('section', { has: admin.locator('#stock-new') }).locator('form')
      await form.waitFor()
      await form.getByLabel('Material *').selectOption({ label: 'Material E2E Estoque (Unidade)' }).catch(async () => {
        const option = await form.locator('select').first().locator('option', { hasText: 'Material E2E Estoque' }).getAttribute('value')
        await form.getByLabel('Material *').selectOption(option)
      })
      await form.getByLabel('Quantidade *').fill('5')
      await form.getByLabel('Justificativa *').fill('Saldo inicial conferido')
      await form.getByRole('button', { name: 'Registrar' }).click()
      await admin.locator('.ui-alert-success', { hasText: 'Movimentação registrada' }).waitFor()
      const row = admin.locator('.data-table tbody tr', { hasText: 'Material E2E Estoque' }).first()
      await row.getByRole('button', { name: 'Definir mínimo' }).click()
      const dialog = admin.locator('dialog[open]')
      await dialog.locator('input').fill('10')
      await dialog.getByRole('button', { name: 'Salvar' }).click()
      await admin.locator('.central-flag-late', { hasText: 'Abaixo do mínimo' }).first().waitFor()
    })

    await step('parâmetros: administrados pela tela, com efeito na Central', async () => {
      await admin.goto('/configuracoes?aba=prazos')
      const form = admin.locator('form', { has: admin.locator('h3', { hasText: 'Prazos e alertas' }) })
      await form.waitFor()
      await form.getByLabel('Dias sem movimentação para alertar').fill('12')
      await form.getByRole('button', { name: 'Salvar' }).click()
      await form.locator('.ui-alert-success').waitFor()
      await operator.goto('/central-slm')
      await operator.getByText('considera 12 dias').waitFor()
      assert.equal((await api(requester, 'GET', '/settings/parameters')).status, 403)
    })

    await step('relatórios, monitoramento e revisão de acessos, cada um com a sua permissão', async () => {
      await operator.goto('/relatorios')
      await operator.waitForSelector('#report-performance')
      await operator.getByText('Atendimentos por responsável').waitFor()
      await admin.goto('/relatorios')
      await admin.waitForSelector('#report-performance')
      assert.equal(await admin.getByText('Atendimentos por responsável').count(), 0)

      await admin.locator('.nav-item', { hasText: 'Monitoramento' }).click()
      await admin.waitForSelector('#monitoring-services')
      await admin.locator('.data-table tr', { hasText: 'Banco de dados' }).getByText('Disponível').waitFor()
      assert.equal((await api(operator, 'GET', '/monitoring/status')).status, 403)

      await admin.goto('/usuarios')
      await admin.getByRole('link', { name: 'Revisão de acessos' }).click()
      const row = admin.locator('.data-table tbody tr', { hasText: 'Pessoa Operadora Central' })
      await row.waitFor()
      await row.getByRole('button', { name: 'Revisar' }).click()
      const dialog = admin.locator('dialog[open]')
      await dialog.getByRole('button', { name: 'Registrar revisão' }).click()
      await admin.locator('.ui-alert-success', { hasText: 'Revisão de Pessoa Operadora Central' }).waitFor()
    })

    await step('a Central e a pesquisa passam na revisão visual em computador, tablet e celular', async () => {
      const failures = []
      if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true })
      for (const viewport of viewports) {
        const page = await login(emails.operator, { width: viewport.width, height: viewport.height })
        for (const path of ['/central-slm', `/pesquisa?q=${protocol}`, detailPath]) {
          await page.goto(path)
          await page.waitForSelector('.page-content h1')
          await page.waitForFunction(() => !document.querySelector('.ui-loading, .ui-spinner'))
          await page.waitForTimeout(200)
          for (const problem of await page.evaluate(auditPage)) {
            failures.push(`${viewport.name} ${path}: ${problem}`)
          }
          if (screenshotDirectory) {
            const name = path.split('?')[0].split('/')[1]
            await page.screenshot({ path: join(screenshotDirectory, `s04-${viewport.name}-${name}.png`), fullPage: true })
          }
        }
        await page.context().close()
      }
      assert.deepEqual(failures, [], `Problemas visuais:\n${failures.join('\n')}`)
    })

    assert.deepEqual(pageErrors, [], `Erros na tela: ${pageErrors.join('; ')}`)
    assert.deepEqual(violations, [], 'Resposta de fora do backend da execução')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
