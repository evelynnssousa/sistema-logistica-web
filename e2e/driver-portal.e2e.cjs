/**
 * Portal do Motorista no navegador: o caminho inteiro, da definição do perfil até a correção de
 * horários, com dois motoristas, para conferir o isolamento. Executado só por
 * scripts/run-browser-tests.cjs, em banco descartável.
 */
const assert = require('node:assert/strict')
const { join } = require('node:path')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const emails = { um: 'e2e-motorista-um@slm-e2e.invalid', dois: 'e2e-motorista-dois@slm-e2e.invalid' }
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

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
    await page.goto('/')
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
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `motorista-${name}.png`), fullPage: true })
  }
  const plusDays = (days) => new Date(Date.now() + days * 86400000).toISOString()

  try {
    const admin = await login(adminEmail, '.topbar-logout')
    // Agendar e atribuir motorista são da equipe SLM (P-08): a administradora fica fora dela.
    const slm = await login('e2e-slm@slm-e2e.invalid', '.topbar-logout')
    const ids = {}
    for (const [key, email] of Object.entries(emails)) {
      ids[key] = (await api(admin, 'GET', `/admin/users?search=${encodeURIComponent(email)}`)).body.users[0].id
    }

    async function newTrip(destination, days) {
      const when = plusDays(days)
      const created = await api(admin, 'POST', '/fleet/requests', {
        origem: 'Sede JUCESP', destino: destination, dataHora: when, finalidade: 'Entrega de documentos', veiculo: 'Van institucional',
        passageiros: [{ nome: 'Passageira E2E' }],
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const scheduled = await api(slm, 'POST', `/fleet/requests/${created.body.id}/schedule`, { dataAgendada: when, confirmarConflito: true })
      assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body))
      return created.body.id
    }

    let driverOneId
    await step('administração: define o perfil pela tela e cadastra o motorista na Frota', async () => {
      await admin.goto(`/usuarios/${ids.um}`)
      const profile = admin.locator('label', { hasText: 'Perfil' }).locator('select').first()
      await profile.selectOption('driver')
      await admin.waitForSelector('text=não aceita permissões individuais')
      assert.equal(await admin.locator('.users-permission-group').count(), 0, 'sem permissões individuais')
      await shot(admin, 'perfil')
      await admin.getByRole('button', { name: 'Salvar acesso' }).click()
      await admin.waitForSelector('text=Acesso atualizado')
      const second = await api(admin, 'PUT', `/admin/users/${ids.dois}/access`, { role: 'driver', slmMember: false, grantedPermissions: [], deniedPermissions: [] })
      assert.equal(second.status, 200, JSON.stringify(second.body))

      await admin.goto('/frota')
      await admin.getByRole('link', { name: 'Motoristas' }).click()
      await admin.waitForURL(/\/frota\/motoristas$/)
      await admin.getByRole('button', { name: 'Novo motorista' }).click()
      const dialog = admin.locator('.ui-modal')
      await dialog.getByLabel('Nome').fill('Motorista E2E Um')
      await dialog.getByLabel('Matrícula (opcional)').fill('E2E-1')
      await dialog.getByLabel('Conta de acesso').selectOption(ids.um)
      await shot(admin, 'cadastro')
      await dialog.getByRole('button', { name: 'Salvar' }).click()
      await admin.waitForSelector('.data-table >> text=Motorista E2E Um')
      await admin.waitForSelector('.data-table >> text=Pode receber viagens')
      await shot(admin, 'motoristas')

      const created = await api(admin, 'POST', '/fleet/drivers', { name: 'Motorista E2E Dois', userId: ids.dois })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      driverOneId = (await api(admin, 'GET', '/fleet/drivers/assignable')).body.drivers.find((item) => item.name === 'Motorista E2E Um').id
    })

    const tripOne = await newTrip('Fórum João Mendes', 2)
    const tripToCancel = await newTrip('Tribunal de Justiça', 3)

    await step('SLM: atribui o motorista na própria solicitação de Frota; a administradora fora da equipe não atribui', async () => {
      assert.equal((await api(admin, 'POST', `/fleet/requests/${tripOne}/driver`, { driverId: driverOneId })).status, 403, 'administradora fora da SLM')
      await slm.goto(`/frota/${tripOne}`)
      const panel = slm.locator('[data-testid="trip-execution"]')
      await panel.waitFor()
      await panel.locator('form select').first().selectOption({ label: 'Motorista E2E Um' })
      await panel.getByLabel(/Observações para o motorista/).fill('Retirar a chave na portaria.')
      await panel.getByRole('button', { name: 'Salvar atribuição' }).click()
      await panel.locator('dd', { hasText: 'Motorista E2E Um' }).waitFor()
      await shot(slm, 'atribuicao')
      assert.equal((await api(slm, 'POST', `/fleet/requests/${tripToCancel}/driver`, { driverId: driverOneId })).status, 200)
      await admin.goto('/frota')
      await admin.waitForSelector('th:has-text("Motorista")')
      await admin.waitForSelector('td:has-text("Motorista E2E Um")')
    })

    const driver = await login(emails.um, '.driver-logout')
    const other = await login(emails.dois, '.driver-logout')

    await step('login: o motorista entra direto no portal, sem a interface administrativa', async () => {
      await driver.waitForURL(/\/motorista$/)
      await driver.waitForSelector('text=Portal do Motorista')
      assert.equal(await driver.locator('.sidebar').count(), 0)
      assert.equal(await driver.locator('.topbar-logout').count(), 0)
      for (const path of ['/dashboard', '/frota', '/manutencao', '/configuracoes', '/almoxarifado', '/demandas', `/frota/${tripOne}`, '/usuarios']) {
        await driver.goto(path)
        await driver.waitForURL(/\/motorista$/)
        await driver.waitForSelector('.driver-portal')
        assert.equal(await driver.locator('.sidebar').count(), 0, path)
      }
      const me = await api(driver, 'GET', '/auth/me')
      assert.deepEqual(me.body.user.permissions, ['driver_portal:access'])
    })

    await step('rotas e APIs: toda tentativa de acesso indevido é recusada', async () => {
      for (const path of ['/dashboard/summary', '/maintenance/requests', '/fleet/requests', '/warehouse/materials', '/demands', '/settings/parameters', '/admin/users', '/search?q=Sede']) {
        assert.equal((await api(driver, 'GET', path)).status, 403, path)
      }
      assert.equal((await api(driver, 'POST', '/fleet/requests', { origem: 'A', destino: 'B' })).status, 403, 'criar solicitação')
      assert.equal((await api(driver, 'POST', `/fleet/requests/${tripOne}/schedule`, { dataAgendada: plusDays(9) })).status, 403, 'reagendar')
      assert.equal((await api(driver, 'POST', `/fleet/requests/${tripOne}/driver`, { driverId: driverOneId })).status, 403, 'atribuir a si')
      assert.equal((await api(driver, 'POST', `/fleet/requests/${tripOne}/execution-correction`, { start: plusDays(-1), reason: 'Tentativa' })).status, 403, 'corrigir')
      assert.equal((await api(driver, 'PUT', `/admin/users/${ids.um}/access`, { role: 'administrator', slmMember: false, grantedPermissions: [], deniedPermissions: [] })).status, 403, 'promover-se')
      assert.equal((await api(admin, 'GET', '/driver/trips')).status, 403, 'o portal é só de motoristas')
    })

    await step('viagens: cada motorista vê só as próprias', async () => {
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' })
      await driver.goto('/motorista')
      await card.waitFor()
      await card.getByText('Sede JUCESP').waitFor()
      await card.getByText('Retirar a chave na portaria.').waitFor()
      await card.getByRole('button', { name: 'Ver detalhes' }).click()
      await card.getByText('Van institucional').waitFor()
      await card.getByText('Passageira E2E').waitFor()
      await shot(driver, 'viagens')

      await other.goto('/motorista')
      await other.waitForSelector('text=Nenhuma viagem aqui')
      assert.equal(await other.locator('text=Fórum João Mendes').count(), 0)
      assert.equal((await api(other, 'GET', `/driver/trips/${tripOne}`)).status, 404)
      assert.equal((await api(other, 'POST', `/driver/trips/${tripOne}/start`, {})).status, 404)
      assert.equal((await api(other, 'POST', `/driver/trips/${tripOne}/occurrences`, { categoria: 'outra', descricao: 'Tentativa' })).status, 404)
    })

    await step('iniciar: confirma, registra o horário e reflete na Frota', async () => {
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' })
      await card.getByRole('button', { name: 'Iniciar viagem' }).click()
      const dialog = driver.locator('.ui-modal')
      await dialog.getByText('Depois de confirmado').waitFor()
      await shot(driver, 'confirmacao')
      await dialog.getByRole('button', { name: 'Voltar' }).click()
      assert.equal((await api(driver, 'GET', `/driver/trips/${tripOne}`)).body.trip.status, 'agendado', 'voltar não registra nada')

      await card.getByRole('button', { name: 'Iniciar viagem' }).click()
      await dialog.getByRole('button', { name: 'Confirmar início' }).click()
      await driver.waitForSelector('text=/Viagem iniciada às/')
      assert.equal((await api(driver, 'POST', `/driver/trips/${tripOne}/start`, {})).status, 409, 'sem início duplicado')

      await driver.locator('.driver-groups button', { hasText: 'Em andamento' }).click()
      const running = driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' })
      await running.getByRole('button', { name: 'Finalizar viagem' }).waitFor()
      assert.equal(await running.getByRole('button', { name: 'Iniciar viagem' }).count(), 0)

      await admin.goto(`/frota/${tripOne}`)
      const panel = admin.locator('[data-testid="trip-execution"]')
      await panel.waitFor()
      await admin.waitForSelector('text=Em andamento')
      assert.notEqual(await panel.locator('dd').nth(1).textContent(), '—', 'início efetivo')
      await admin.waitForSelector('text=Atendimento iniciado')
    })

    await step('ocorrência: com anexo, para a equipe consultar', async () => {
      const running = driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' })
      await running.getByRole('button', { name: 'Registrar ocorrência' }).click()
      const dialog = driver.locator('.ui-modal')
      await dialog.getByLabel('O que aconteceu?').selectOption('veiculo')
      await dialog.getByLabel('Descrição').fill('Pneu furado na marginal.')
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'foto-pneu.pdf', mimeType: 'application/pdf', buffer: pdf })
      await shot(driver, 'ocorrencia')
      const submit = dialog.getByRole('button', { name: 'Registrar ocorrência' })
      assert.equal(await submit.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(3, 78, 162)', 'botão principal em azul institucional')
      await submit.click()
      await driver.waitForSelector('text=Ocorrência registrada. A equipe de Frota já pode consultar.')

      await admin.goto(`/frota/${tripOne}`)
      const panel = admin.locator('[data-testid="trip-execution"]')
      await panel.getByText('Pneu furado na marginal.').waitFor()
      await panel.getByText('Problema mecânico').waitFor()
      await panel.getByRole('link', { name: 'foto-pneu.pdf' }).waitFor()
    })

    await step('finalizar: registra o término e o tempo efetivo, e entra no histórico', async () => {
      const running = driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' })
      await running.getByRole('button', { name: 'Finalizar viagem' }).click()
      await driver.locator('.ui-modal').getByRole('button', { name: 'Confirmar término' }).click()
      await driver.waitForSelector('text=/Viagem finalizada às .*Tempo efetivo/')
      assert.equal((await api(driver, 'POST', `/driver/trips/${tripOne}/finish`, {})).status, 409, 'sem término duplicado')

      await driver.locator('.driver-groups button', { hasText: 'Concluídas' }).click()
      await driver.locator('[data-testid="driver-trip"]', { hasText: 'Fórum João Mendes' }).waitFor()

      await driver.locator('.driver-tabs button', { hasText: 'Histórico' }).click()
      const item = driver.locator('[data-testid="driver-history-item"]', { hasText: 'Fórum João Mendes' })
      await item.getByText('Início efetivo').waitFor()
      await item.getByText('Término efetivo').waitFor()
      await item.getByText('Pneu furado na marginal.').waitFor()
      await shot(driver, 'historico')

      await other.locator('.driver-tabs button', { hasText: 'Histórico' }).click()
      await other.waitForSelector('text=Nenhuma viagem no histórico')
    })

    await step('correção: só com autorização, com motivo, preservando o original', async () => {
      await admin.goto(`/frota/${tripOne}`)
      const panel = admin.locator('[data-testid="trip-execution"]')
      await admin.locator('text=Atendimento concluído').first().waitFor()
      const form = panel.locator('form', { hasText: 'Corrigir horários' })
      const earlier = new Date(Date.now() - 2 * 3600000)
      const pad = (value) => String(value).padStart(2, '0')
      const local = `${earlier.getFullYear()}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}T${pad(earlier.getHours())}:${pad(earlier.getMinutes())}`
      await form.getByLabel('Início efetivo').fill(local)
      await form.getByLabel('Motivo da correção').fill('Motorista iniciou depois da saída.')
      await form.getByRole('button', { name: 'Registrar correção' }).click()
      await panel.getByText('Motorista iniciou depois da saída.').waitFor()
      await admin.waitForSelector('text=Horários de execução corrigidos')
      await shot(admin, 'execucao')
      const execution = await api(admin, 'GET', `/fleet/requests/${tripOne}/execution`)
      assert.equal(execution.body.corrections.length, 1)
      assert.ok(execution.body.corrections[0].previousStart, 'o horário original fica guardado')
      assert.notEqual(execution.body.corrections[0].previousStart, execution.body.corrections[0].newStart)
      assert.equal(execution.body.corrections[0].previousEnd, execution.body.corrections[0].newEnd, 'o término, que não foi mexido, não muda')
      const changed = (await api(admin, 'GET', `/fleet/requests/${tripOne}`)).body.history.find((item) => item.action === 'execucao_corrigida')
      assert.deepEqual(changed.details.alteracoes.map((item) => item.campo), ['Início efetivo'])
    })

    await step('avisos: o motorista sabe da atribuição e do cancelamento', async () => {
      const cancelled = await api(admin, 'POST', `/fleet/requests/${tripToCancel}/cancel`, { motivoCodigo: 'outro', motivo: 'Audiência desmarcada pelo fórum' })
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body))
      await driver.goto('/motorista')
      await driver.locator('.driver-tabs button', { hasText: 'Avisos' }).click()
      await driver.waitForSelector('.driver-notices >> text=/Nova viagem atribuída/')
      await driver.waitForSelector('.driver-notices >> text=/foi cancelada/')
      await shot(driver, 'avisos')
      await driver.locator('.driver-tabs button', { hasText: 'Viagens' }).click()
      await driver.locator('.driver-groups button', { hasText: 'Canceladas' }).click()
      const card = driver.locator('[data-testid="driver-trip"]', { hasText: 'Tribunal de Justiça' })
      await card.waitFor()
      assert.equal(await card.getByRole('button', { name: 'Iniciar viagem' }).count(), 0)
      assert.equal(await driver.locator('text=Audiência desmarcada pelo fórum').count(), 0, 'o motivo é interno')
    })

    await step('celular: sem rolagem lateral, com botões grandes e a paleta institucional', async () => {
      const tripMobile = await newTrip('Cartório de Registro com um nome bem longo para testar a quebra de linha na tela do celular', 1)
      assert.equal((await api(slm, 'POST', `/fleet/requests/${tripMobile}/driver`, { driverId: driverOneId, notes: 'Orientação longa para o motorista, conferindo a quebra de linha no aparelho.' })).status, 200)
      const phone = await login(emails.um, '.driver-logout', { width: 390, height: 800 })
      const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      const card = phone.locator('[data-testid="driver-trip"]', { hasText: 'Cartório de Registro' })
      await card.waitFor()
      assert.ok((await overflow()) <= 1, 'viagens')
      await shot(phone, 'celular-viagens')

      const start = card.getByRole('button', { name: 'Iniciar viagem' })
      const box = await start.boundingBox()
      assert.ok(box.height >= 44, `botão com ${box.height}px`)
      assert.equal(await start.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(3, 78, 162)', 'azul institucional #034EA2')
      assert.equal(await phone.locator('.driver-header').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(23, 54, 93)', 'azul executivo #17365D')

      await card.getByRole('button', { name: 'Registrar ocorrência' }).click()
      assert.ok((await overflow()) <= 1, 'ocorrência')
      await shot(phone, 'celular-ocorrencia')
      await phone.locator('.ui-modal').getByRole('button', { name: 'Voltar' }).click()
      for (const tab of ['Histórico', 'Avisos']) {
        await phone.locator('.driver-tabs button', { hasText: tab }).click()
        await phone.waitForLoadState('networkidle')
        assert.ok((await overflow()) <= 1, tab)
        await shot(phone, `celular-${tab === 'Avisos' ? 'avisos' : 'historico'}`)
      }
    })

    await step('sessão e situação: desativar tira o portal na hora, e a Frota continua', async () => {
      const removed = await api(admin, 'PUT', `/admin/users/${ids.dois}/access`, { role: 'requester', slmMember: false, grantedPermissions: [], deniedPermissions: [] })
      assert.equal(removed.status, 200, JSON.stringify(removed.body))
      assert.equal((await api(other, 'GET', '/driver/trips')).status, 403)
      await other.goto('/')
      await other.waitForSelector('.topbar-logout')
      assert.equal(await other.locator('.driver-portal').count(), 0, 'volta à interface comum')
      await admin.goto('/frota')
      await admin.waitForSelector('td:has-text("Fórum João Mendes")')
    })

    assert.deepEqual(violations, [], 'resposta de outro backend')
    assert.deepEqual(pageErrors, [], 'erro na página')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
