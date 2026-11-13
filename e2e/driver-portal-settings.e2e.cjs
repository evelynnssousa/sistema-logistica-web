/**
 * Configurações do Portal do Motorista no navegador: a administração altera pela tela, e o motorista vê
 * o efeito no portal. Executado só por scripts/run-browser-tests.cjs, em banco descartável.
 */
const assert = require('node:assert/strict')
const { join } = require('node:path')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const driverEmail = 'e2e-motorista-config@slm-e2e.invalid'

async function run({ playwright, baseUrl, runId, password, screenshotDirectory }) {
  const browser = await playwright.chromium.launch({ args: ['--disable-dev-shm-usage'] })
  const origin = new URL(baseUrl).origin
  const violations = []
  const pageErrors = []

  async function login(email, readySelector, viewport = { width: 1360, height: 900 }) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport })
    context.setDefaultTimeout(20000)
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()))
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
    await page.waitForSelector(readySelector)
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
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `portal-config-${name}.png`), fullPage: true })
  }

  try {
    const admin = await login(adminEmail, '.topbar-logout')
    // Agendar e atribuir motorista são da equipe SLM (P-08): a administradora fica fora dela.
    const slm = await login('e2e-slm@slm-e2e.invalid', '.topbar-logout')
    const driverAccount = (await api(admin, 'GET', `/admin/users?search=${encodeURIComponent(driverEmail)}`)).body.users[0].id
    assert.equal((await api(admin, 'PUT', `/admin/users/${driverAccount}/access`, { role: 'driver', slmMember: false, grantedPermissions: [], deniedPermissions: [] })).status, 200)
    const driverId = (await api(admin, 'POST', '/fleet/drivers', { name: 'Motorista Config', userId: driverAccount })).body.id

    // Dentro do período padrão de Próximas, em horários diferentes.
    let tripDays = 1
    async function newTrip(destination) {
      tripDays += 0.25
      const when = new Date(Date.now() + tripDays * 86400000).toISOString()
      const created = await api(admin, 'POST', '/fleet/requests', {
        origem: 'Sede Config', destino: destination, dataHora: when, finalidade: 'Entrega de documentos', veiculo: 'Van Config',
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const id = created.body.id
      assert.equal((await api(slm, 'POST', `/fleet/requests/${id}/schedule`, { dataAgendada: when, confirmarConflito: true })).status, 200)
      assert.equal((await api(slm, 'POST', `/fleet/requests/${id}/driver`, { driverId, confirmConflicts: true })).status, 200)
      return id
    }

    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date()))
    const weekdayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
    const block = (name) => admin.getByRole('form', { name })

    async function saveBlock(name, { confirm = false } = {}) {
      const form = block(name)
      await form.getByRole('button', { name: 'Salvar', exact: true }).click()
      if (confirm) await admin.locator('.ui-modal [data-confirm]').click()
      await form.getByText('Alterações salvas').waitFor()
    }

    const driver = await login(driverEmail, '.driver-logout')
    const tripOld = await newTrip('Destino Antigo')

    await step('padrão: a tela abre com as 07h às 19h, e o portal usa', async () => {
      await admin.goto('/configuracoes')
      const form = block('Jornada de trabalho')
      await form.waitFor()
      assert.equal(await form.getByLabel('Início da jornada').inputValue(), '07:00')
      assert.equal(await form.getByLabel('Término da jornada').inputValue(), '19:00')
      await shot(admin, 'tela')
      await driver.goto('/motorista')
      await driver.getByTestId('driver-journey').getByText('07:00 às 19:00').waitFor()
    })

    await step('cancelar: desfaz o que foi digitado, sem gravar', async () => {
      const form = block('Jornada de trabalho')
      await form.getByLabel('Início da jornada').fill('05:00')
      await form.getByRole('button', { name: 'Cancelar' }).click()
      assert.equal(await block('Jornada de trabalho').getByLabel('Início da jornada').inputValue(), '07:00')
      assert.equal((await api(admin, 'GET', '/settings/parameters')).body.settings.driverJourney.start, '07:00')
    })

    await step('viagem anterior: registrada dentro da jornada vigente', async () => {
      // Dia inteiro: o teste não depende da hora em que roda.
      const form = block('Jornada de trabalho')
      await form.getByLabel('Início da jornada').fill('00:00')
      await form.getByLabel('Término da jornada').fill('23:59')
      await saveBlock('Jornada de trabalho', { confirm: true })
      assert.equal((await api(driver, 'POST', `/driver/trips/${tripOld}/start`, {})).status, 200)
      assert.equal((await api(driver, 'POST', `/driver/trips/${tripOld}/finish`, {})).status, 200)
    })

    await step('jornada: confirma antes, muda dias pela tela, exige justificativa, e o passado não muda', async () => {
      const form = block('Jornada de trabalho')
      await form.getByLabel(weekdayNames[today]).uncheck()
      await form.getByLabel('Viagem iniciada fora da jornada').selectOption('justify')
      await form.getByRole('button', { name: 'Salvar', exact: true }).click()
      const dialog = admin.locator('.ui-modal')
      await dialog.getByText('os registros anteriores não mudam').waitFor()
      await shot(admin, 'confirmacao')
      await dialog.getByRole('button', { name: 'Voltar' }).click()
      assert.ok((await api(admin, 'GET', '/settings/parameters')).body.settings.driverJourney.weekdays.includes(today), 'voltar não grava')
      await saveBlock('Jornada de trabalho', { confirm: true })

      assert.equal((await api(driver, 'GET', `/driver/trips/${tripOld}`)).body.trip.exceedsJourney, false, 'viagem anterior intacta')

      const trip = await newTrip('Destino Justificado')
      await driver.goto('/motorista')
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Destino Justificado' })
      await card.getByRole('button', { name: 'Iniciar viagem' }).click()
      const modal = driver.locator('.ui-modal')
      await modal.getByLabel('Justificativa por estar fora da jornada').fill('Audiência antecipada')
      await shot(driver, 'justificativa')
      await modal.getByRole('button', { name: 'Confirmar início' }).click()
      await driver.waitForSelector('text=/Viagem iniciada às/')
      const execution = await api(admin, 'GET', `/fleet/requests/${trip}/execution`)
      assert.equal(execution.body.startRecord.justificativa, 'Audiência antecipada')
      assert.equal((await api(driver, 'POST', `/driver/trips/${trip}/finish`, {})).status, 200)
    })

    await step('jornada: sem registro excepcional, o portal não oferece iniciar', async () => {
      await block('Jornada de trabalho').getByLabel(/Permitir registros excepcionais/).uncheck()
      await saveBlock('Jornada de trabalho', { confirm: true })
      await newTrip('Destino Bloqueado')
      await driver.goto('/motorista')
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Destino Bloqueado' })
      await card.getByText('não inicia pelo portal').waitFor()
      assert.equal(await card.getByRole('button', { name: 'Iniciar viagem' }).count(), 0)
      // Volta para o restante do cenário.
      await block('Jornada de trabalho').getByLabel(weekdayNames[today]).check()
      await block('Jornada de trabalho').getByLabel(/Permitir registros excepcionais/).check()
      await saveBlock('Jornada de trabalho', { confirm: true })
    })

    await step('execução: o campo obrigatório aparece e é exigido no portal', async () => {
      const form = block('Execução das viagens')
      await form.getByRole('group', { name: 'Obrigatório para iniciar' }).getByLabel('Hodômetro').check()
      await saveBlock('Execução das viagens')
      const trip = await newTrip('Destino Hodometro')
      await driver.goto('/motorista')
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Destino Hodometro' })
      await card.getByRole('button', { name: 'Iniciar viagem' }).click()
      const modal = driver.locator('.ui-modal')
      await modal.getByLabel('Hodômetro (km)').fill('12345')
      await modal.getByRole('button', { name: 'Confirmar início' }).click()
      await driver.waitForSelector('text=/Viagem iniciada às/')
      assert.equal((await api(admin, 'GET', `/fleet/requests/${trip}/execution`)).body.startRecord.hodometro, 12345)
      await admin.goto(`/frota/${trip}`)
      await admin.getByTestId('trip-execution-record').getByText('hodômetro 12345').waitFor()
      assert.equal((await api(driver, 'POST', `/driver/trips/${trip}/finish`, {})).status, 200)
      await admin.goto('/configuracoes')
      await block('Execução das viagens').getByRole('group', { name: 'Obrigatório para iniciar' }).getByLabel('Hodômetro').uncheck()
      await saveBlock('Execução das viagens')
    })

    await step('tipos de ocorrência: incluir, editar e desativar pela tela, sem mudar o registrado', async () => {
      const section = admin.getByRole('region', { name: 'Tipos de ocorrência' })
      await section.getByLabel('Novo tipo de ocorrência').fill('Pneu furado E2E')
      await section.getByLabel('Exige justificativa', { exact: true }).check()
      await section.getByRole('button', { name: 'Adicionar tipo' }).click()
      const row = section.locator('tr[data-type="pneu_furado_e2e"]')
      await row.waitFor()
      await shot(admin, 'tipos')

      const trip = await newTrip('Destino Ocorrencia')
      await driver.goto('/motorista')
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Destino Ocorrencia' })
      await card.getByRole('button', { name: 'Registrar ocorrência' }).click()
      const modal = driver.locator('.ui-modal')
      await modal.getByLabel('O que aconteceu?').selectOption({ label: 'Pneu furado E2E' })
      await modal.getByLabel('Descrição').fill('Pneu furou na marginal')
      await modal.getByLabel('Justificativa').fill('Buraco na via')
      await modal.getByRole('button', { name: 'Registrar ocorrência' }).click()
      await driver.waitForSelector('text=Ocorrência registrada. A equipe de Frota já pode consultar.')

      await row.getByRole('textbox').fill('Pneu avariado E2E')
      await row.getByRole('button', { name: 'Salvar' }).click()
      await section.getByText('Tipo atualizado').waitFor()
      await row.getByRole('button', { name: 'Desativar' }).click()
      await admin.locator('.ui-modal [data-confirm]').click()
      await row.getByRole('cell', { name: 'Inativo' }).waitFor()

      await driver.goto('/motorista')
      await card.getByRole('button', { name: 'Registrar ocorrência' }).click()
      const options = await modal.getByLabel('O que aconteceu?').locator('option').allTextContents()
      assert.equal(options.some((label) => label.includes('Pneu')), false, 'sai das escolhas')
      assert.ok(options.includes('Problema mecânico'))
      await modal.getByRole('button', { name: 'Voltar' }).click()
      await card.getByRole('button', { name: 'Ver detalhes' }).click()
      await card.getByText('Pneu furado E2E').waitFor()
      await card.getByText('Justificativa: Buraco na via').waitFor()
    })

    await step('notificações: desligar pela tela cala o aviso ao motorista', async () => {
      const form = block('Regras de notificação')
      await form.getByLabel('Nova viagem atribuída, motorista').uncheck()
      await saveBlock('Regras de notificação')
      const before = (await api(driver, 'GET', '/notifications')).body.total
      await newTrip('Destino Sem Aviso')
      assert.equal((await api(driver, 'GET', '/notifications')).body.total, before)
      await block('Regras de notificação').getByLabel('Nova viagem atribuída, motorista').check()
      await saveBlock('Regras de notificação')
      await newTrip('Destino Com Aviso')
      assert.equal((await api(driver, 'GET', '/notifications')).body.total, before + 1)
    })

    await step('visualização: cartão, avisos, orientação e contato chegam ao portal', async () => {
      const form = block('Visualização')
      await form.getByLabel('Veículo').selectOption('card')
      await form.getByLabel('Saída').selectOption('hidden')
      await form.getByRole('button', { name: 'Adicionar aviso' }).click()
      await form.getByLabel('Aviso 1').fill('Use o crachá em todas as viagens')
      await form.getByRole('group', { name: 'Mensagem de orientação aos motoristas' }).getByLabel('Exibir no portal').check()
      await form.getByLabel('Orientação', { exact: true }).fill('Confira os documentos antes de sair')
      const contact = form.getByRole('group', { name: 'Contato administrativo para situações excepcionais' })
      await contact.getByLabel('Exibir no portal').check()
      await contact.getByLabel('Nome ou setor').fill('Central de Frota')
      await contact.getByLabel('Telefone').fill('(11) 3333-4444')
      await saveBlock('Visualização')

      await driver.goto('/motorista')
      await driver.getByTestId('driver-notice').getByText('Use o crachá').waitFor()
      await driver.getByText('Confira os documentos antes de sair').waitFor()
      await driver.getByTestId('driver-contact').getByText('Central de Frota').waitFor()
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Destino Com Aviso' })
      await card.getByText('Van Config').waitFor()
      assert.equal(await card.getByText('Sede Config').count(), 0, 'saída oculta')
      await shot(driver, 'portal')
    })

    await step('celular: as mensagens não criam rolagem lateral', async () => {
      const phone = await login(driverEmail, '.driver-logout', { width: 390, height: 800 })
      await phone.getByTestId('driver-notice').waitFor()
      assert.ok((await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1)
      await shot(phone, 'celular')
    })

    await step('acesso: desativar o portal avisa o motorista e corta as viagens', async () => {
      const form = block('Acesso e funcionalidades')
      await form.getByLabel('Portal do Motorista ativo').uncheck()
      await form.getByRole('button', { name: 'Salvar', exact: true }).click()
      await admin.locator('.ui-modal').getByText('Os motoristas deixam de ver as viagens').waitFor()
      await admin.locator('.ui-modal [data-confirm]').click()
      await form.getByText('Alterações salvas').waitFor()

      await driver.goto('/motorista')
      await driver.getByText('O Portal do Motorista está desativado pela administração').waitFor()
      assert.equal(await driver.locator('[data-testid="driver-trip"]').count(), 0)
      await driver.getByTestId('driver-contact').waitFor()
      assert.equal((await api(driver, 'GET', '/driver/trips')).status, 403)

      await block('Acesso e funcionalidades').getByLabel('Portal do Motorista ativo').check()
      await saveBlock('Acesso e funcionalidades')
      await driver.goto('/motorista')
      await driver.locator('[data-testid="driver-trip"]').first().waitFor()
    })

    await step('persistência: sair e entrar mantém tudo, e o histórico mostra autor e valores', async () => {
      await admin.getByRole('button', { name: /Sair/ }).first().click().catch(() => undefined)
      const again = await login(adminEmail, '.topbar-logout')
      await again.goto('/configuracoes')
      await again.getByRole('form', { name: 'Jornada de trabalho' }).waitFor()
      assert.equal(await again.getByRole('form', { name: 'Jornada de trabalho' }).getByLabel('Início da jornada').inputValue(), '00:00')
      assert.equal(await again.getByRole('form', { name: 'Visualização' }).getByLabel('Aviso 1').inputValue(), 'Use o crachá em todas as viagens')
      const history = again.getByTestId('driver-settings-history')
      await history.locator('summary').click()
      await history.getByText('Jornada de trabalho').first().waitFor()
      await history.getByText('Administradora E2E').first().waitFor()
      await history.getByText(/Antes:.*07:00|Antes:.*00:00/).first().waitFor()
      await history.getByText('Tipos de ocorrência').first().waitFor()
      await shot(again, 'historico')
    })

    await step('sem permissão: o motorista não edita, e quem só solicita nem abre', async () => {
      assert.equal((await api(driver, 'PUT', '/settings/parameters/driverAccess', { portalEnabled: true })).status, 403)
      assert.equal((await api(driver, 'GET', '/settings/parameters')).status, 403)
      await driver.goto('/configuracoes')
      await driver.waitForURL(/\/motorista$/)
    })

    assert.deepEqual(violations, [], 'resposta de outro backend')
    assert.deepEqual(pageErrors, [], 'erro na página')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
