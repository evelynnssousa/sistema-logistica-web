/**
 * Rotinas institucionais no navegador: aviso de privacidade, conflito de agenda, notificações e
 * administração das integrações. Executado somente por scripts/run-browser-tests.cjs. Os
 * provedores são simulados: nenhum e-mail ou evento de calendário sai da máquina.
 */
const assert = require('node:assert/strict')

const emails = {
  admin: 'e2e-admin@slm-e2e.invalid',
  requester: 'e2e-rotinas-solicitante@slm-e2e.invalid',
  operator: 'e2e-rotinas-operadora@slm-e2e.invalid',
}

async function run({ playwright, baseUrl, runId, password }) {
  const browser = await playwright.chromium.launch()
  const pageErrors = []
  const violations = []
  const baseOrigin = new URL(baseUrl).origin

  async function newPage(viewport = { width: 1360, height: 900 }) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport })
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

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
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

  const inFuture = (days) => {
    const date = new Date(Date.now() + days * 86_400_000)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`
  }

  async function openMaintenance(requester, place) {
    await requester.goto('/manutencao/nova')
    await requester.waitForSelector('select[name="andar"] option:not([value=""])', { state: 'attached' })
    await requester.selectOption('select[name="andar"]', { label: '1º andar' })
    await requester.selectOption('select[name="tipoSolicitacao"]', { label: 'Elétrica' })
    await requester.fill('[name="localServico"]', place)
    await requester.fill('[name="descricao"]', 'Lâmpada queimada')
    await requester.click('button[type=submit]')
    // Solicitações parecidas de propósito: o alerta de duplicidade aparece, e a pessoa decide enviar.
    await requester.waitForSelector('.request-detail-page, [data-testid=duplicate-warning]')
    const warning = requester.locator('[data-testid=duplicate-warning]')
    if (await warning.count()) await warning.locator('button', { hasText: 'Enviar mesmo assim' }).click()
    await requester.waitForSelector('.request-detail-page')
    return new URL(requester.url()).pathname
  }

  const scheduleForm = (page) =>
    page.locator('.detail-action', { has: page.locator('h3', { hasText: /agendar/i }) })

  try {
    const admin = await login(emails.admin)
    await register('Pessoa Solicitante Rotinas', emails.requester, 'Protocolo')
    await register('Pessoa Operadora Rotinas', emails.operator, 'CPC')
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

    await step('os formulários apresentam o aviso de privacidade, sem pedir aceite', async () => {
      for (const path of ['/manutencao/nova', '/frota/nova', '/passagens-aereas/nova', '/almoxarifado/nova']) {
        await requester.goto(path)
        const notice = requester.locator('.privacy-notice')
        await notice.waitFor()
        const text = await notice.textContent()
        for (const expected of ['Finalidade', 'Dados necessários', 'Uso no serviço']) {
          assert.ok(text.includes(expected), `${path} sem "${expected}"`)
        }
        assert.equal(await notice.locator('input').count(), 0, `${path} pede aceite`)
        const page = await requester.locator('body').textContent()
        assert.ok(!page.includes('você concorda'), `${path} trata o aviso como consentimento`)
      }
      await requester.goto('/passagens-aereas/nova')
      assert.ok((await requester.locator('.privacy-notice').textContent()).includes('cifrado'))
    })

    const first = await openMaintenance(requester, 'Sala E2E um')
    const second = await openMaintenance(requester, 'Sala E2E dois')

    await step('a equipe é notificada, e o sino leva à solicitação', async () => {
      await operator.goto('/notificacoes')
      const item = operator.locator('.notification-list li', { hasText: 'Nova solicitação' }).first()
      await item.waitFor()
      const before = await operator.locator('.notification-bell').getAttribute('aria-label')
      assert.match(before, /não lidas/)
      await item.locator('button').click()
      await operator.waitForSelector('.request-detail-page')
      assert.match(new URL(operator.url()).pathname, /^\/manutencao\//)
    })

    await step('conflito de agenda pede confirmação, e a decisão fica no histórico', async () => {
      // A concessão individual de agendar vem da administradora.
      const userId = await operator.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id)
      await admin.goto(`/usuarios/${userId}?aba=acesso`)
      await admin.waitForSelector('.users-permission')
      await admin.locator('.users-permission', { hasText: 'requests:schedule' }).locator('select').selectOption('grant')
      await admin.click('button:has-text("Salvar acesso")')
      await admin.waitForSelector('.page-section > [role=status]')

      await operator.goto(first)
      await scheduleForm(operator).waitFor()
      await scheduleForm(operator).locator('input[type=datetime-local]').first().fill(inFuture(40))
      await scheduleForm(operator).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Agendado' }).waitFor()

      await operator.goto(second)
      await scheduleForm(operator).waitFor()
      await scheduleForm(operator).locator('input[type=datetime-local]').first().fill(inFuture(40))
      await scheduleForm(operator).locator('button[type=submit]').click()
      await operator.locator('.schedule-conflicts').waitFor()
      assert.equal(await operator.locator('.detail-status').textContent(), 'Aguardando agendamento')

      await operator.locator('.schedule-conflicts input[type=checkbox]').check()
      await scheduleForm(operator).locator('button[type=submit]').click()
      await operator.locator('.detail-status', { hasText: 'Agendado' }).waitFor()
    })

    await step('agenda: filtros, detalhes, reagendamento e cancelamento sem sair da tela', async () => {
      await operator.goto('/calendario')
      await operator.locator('.calendar-view-controls button', { hasText: 'Dia' }).click()
      const target = new Date(Date.now() + 40 * 86_400_000)
      for (let index = 0; index < 40; index += 1) {
        if (new Date(Date.now() + index * 86_400_000).toDateString() === target.toDateString()) break
        await operator.click('[aria-label="Período seguinte"]')
      }
      const event = operator.locator('.calendar-event', { hasText: 'Sala E2E dois' })
      await event.waitFor()

      await operator.selectOption('.calendar-filter-row select >> nth=0', 'cancelado')
      await event.waitFor({ state: 'detached' })
      await operator.selectOption('.calendar-filter-row select >> nth=0', '')
      await event.waitFor()

      await event.click()
      const dialog = operator.locator('dialog.ui-modal')
      await dialog.locator('.calendar-details').waitFor()
      assert.ok((await dialog.textContent()).includes('Agendamento realizado'))

      await dialog.locator('.detail-action', { hasText: 'Reagendar' }).locator('input[type=datetime-local]').first().fill(inFuture(41))
      await dialog.locator('.detail-action', { hasText: 'Reagendar' }).locator('label', { hasText: 'Motivo da alteração' }).locator('select').selectOption('equipe_indisponivel')
      await dialog.locator('.detail-action', { hasText: 'Reagendar' }).locator('textarea').fill('Equipe indisponível')
      await dialog.locator('.detail-action', { hasText: 'Reagendar' }).locator('button[type=submit]').click()
      await dialog.locator('.detail-history li', { hasText: 'Reagendamento' }).waitFor()

      await dialog.locator('.detail-action', { hasText: 'Cancelar solicitação' }).locator('select').selectOption('servico_desnecessario')
      await dialog.locator('.detail-action', { hasText: 'Cancelar solicitação' }).locator('textarea').fill('Não é mais necessário')
      await dialog.locator('.detail-action', { hasText: 'Cancelar solicitação' }).locator('button[type=submit]').click()
      await dialog.locator('.detail-history li', { hasText: 'Solicitação cancelada' }).waitFor()
      await dialog.locator('[aria-label="Fechar"]').click()
    })

    await step('solicitante acompanha pelo sistema, sem ver os dados da equipe', async () => {
      await requester.goto('/notificacoes')
      await requester.locator('.notification-list li', { hasText: 'cancelada' }).waitFor()
      const unread = requester.locator('.notification-list li.is-unread')
      assert.ok((await unread.count()) >= 1)
      await requester.click('button:has-text("Marcar todas como lidas")')
      await requester.locator('.notification-list li.is-unread').first().waitFor({ state: 'detached' })
      await requester.goto('/integracoes')
      await requester.waitForSelector('text=/permiss|acesso/i')
      assert.equal(await requester.locator('.integrations-page').count(), 0)
    })

    await step('celular: notificações sem rolagem lateral', async () => {
      const phone = await login(emails.requester, { width: 390, height: 800 })
      await phone.goto('/notificacoes')
      await phone.locator('.notification-list').waitFor()
      const overflow = await phone.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      assert.ok(overflow <= 0, `rolagem lateral de ${overflow}px`)
      await phone.locator('.notification-bell').waitFor()
      await phone.context().close()
    })

    await step('administração: envios simulados identificados, sem dizer que a integração está ativa', async () => {
      await admin.goto('/integracoes')
      await admin.locator('.integration-mode').first().waitFor()
      const modes = await admin.locator('.integration-mode').allTextContents()
      // Só o e-mail: o calendário externo foi removido em 11/11/2026.
      assert.deepEqual(modes, ['Simulado'])
      assert.ok(!(await admin.locator('.integrations-page').textContent()).toLowerCase().includes('ativa '))

      // O worker processa a fila de verdade, com o transporte simulado.
      await admin.click('.module-tabs button:has-text("E-mails")')
      await admin.selectOption('.ui-filter-field select >> nth=0', 'sent')
      const sent = admin.locator('.integration-table tbody tr', { hasText: '(simulado)' }).first()
      for (let attempt = 0; attempt < 45 && !(await sent.count()); attempt += 1) {
        await admin.waitForTimeout(1000)
        await admin.selectOption('.ui-filter-field select >> nth=0', '')
        await admin.selectOption('.ui-filter-field select >> nth=0', 'sent')
      }
      await sent.waitFor()
      // O endereço completo não aparece na lista.
      const table = await admin.locator('.integration-table').textContent()
      assert.ok(!table.includes(emails.requester))
      assert.ok(table.includes('e2***@slm-e2e.invalid'))

      // A aba do calendário externo saiu com a remoção do Google Calendar.
      assert.equal(await admin.locator('.module-tabs button:has-text("Calendário externo")').count(), 0)

      await admin.click('.module-tabs button:has-text("Modelos")')
      await admin.locator('.integration-templates details', { hasText: 'Comunicação de reagendamento' }).click()
      assert.ok((await admin.locator('.integration-templates').textContent()).includes('Atendimento reagendado'))
    })

    await step('relatórios mostram os indicadores e a limitação dos dados', async () => {
      await admin.goto('/relatorios')
      const section = admin.locator('.operational-report')
      await section.waitFor()
      const text = await section.textContent()
      for (const expected of ['Agendamentos', 'Reagendamentos', 'Cancelamentos', 'período considera']) {
        assert.ok(text.includes(expected), `relatório sem "${expected}"`)
      }
    })

    await step('rotinas: toda resposta veio do backend desta execução, sem erros de página', async () => {
      assert.deepEqual(violations, [])
      assert.deepEqual(pageErrors, [])
    })
  } finally {
    await browser.close()
  }
}

module.exports = { run }
