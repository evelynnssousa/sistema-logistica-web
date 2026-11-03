/**
 * Fluxos de acesso no navegador. Executado somente por scripts/run-browser-tests.cjs,
 * que fornece o endereço isolado e a senha aleatória desta execução.
 */
const assert = require('node:assert/strict')

const emails = {
  admin: 'e2e-admin@slm-e2e.invalid',
  requester: 'e2e-solicitante@slm-e2e.invalid',
  operator: 'e2e-operadora@slm-e2e.invalid',
}

async function run({ playwright, baseUrl, runId, password }) {
  const browser = await playwright.chromium.launch()
  const violations = []
  const blockedOrigins = new Set()
  const baseOrigin = new URL(baseUrl).origin

  async function newContext() {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } })

    // O navegador só alcança a tela desta execução.
    await context.route('**/*', (route) => {
      const { origin } = new URL(route.request().url())
      if (origin === baseOrigin) return route.continue()
      blockedOrigins.add(origin)
      return route.abort()
    })

    // Toda resposta da API precisa vir do backend desta execução.
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/') && response.headers()['x-slm-e2e-run'] !== runId) {
        violations.push(url.pathname)
      }
    })

    return context
  }

  const pageErrors = []

  async function login(email) {
    const context = await newContext()
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto('/')
    await page.fill('#login-identifier', email)
    await page.fill('#login-password', password)
    await page.click('.login-submit')
    await page.waitForSelector('.topbar-logout')
    return page
  }

  async function register(name, email, sector) {
    const context = await newContext()
    const page = await context.newPage()
    await page.goto('/')
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

  const menu = (page) => page.$$eval('.nav-label', (items) => items.map((item) => item.textContent))

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  try {
    let admin
    let requester
    let requesterId

    await step('recusa senha errada, com mensagem genérica', async () => {
      const context = await newContext()
      const page = await context.newPage()
      await page.goto('/')
      assert.equal(await page.getAttribute('#login-identifier', 'placeholder'), 'Digite seu e-mail')
      await page.fill('#login-identifier', emails.admin)
      await page.fill('#login-password', `${password}-errada`)
      await page.click('.login-submit')
      await page.waitForSelector('.login-error')
      assert.equal(await page.textContent('.login-error'), 'E-mail ou senha inválidos.')
      await context.close()
    })

    await step('cadastro fica pendente até a aprovação', async () => {
      await register('Pessoa Solicitante', emails.requester, 'RH')
      await register('Pessoa Operadora', emails.operator, 'CPC')

      const context = await newContext()
      const page = await context.newPage()
      await page.goto('/')
      await page.fill('#login-identifier', emails.requester)
      await page.fill('#login-password', password)
      await page.click('.login-submit')
      await page.waitForSelector('.login-error')
      await context.close()
    })

    await step('administradora aprova com o perfil escolhido', async () => {
      admin = await login(emails.admin)
      assert.ok((await menu(admin)).includes('Usuários'))

      await admin.goto('/cadastros-pendentes')
      await admin.waitForSelector('.data-table')
      for (const [email, role] of [[emails.requester, 'requester'], [emails.operator, 'slm_operator']]) {
        const row = admin.locator('.data-table tbody tr', { hasText: email })
        await row.locator('select').selectOption(role)
        await row.locator('.table-actions button').first().click()
        await row.waitFor({ state: 'detached' })
      }
    })

    await step('menu e acesso direto por URL seguem as permissões', async () => {
      requester = await login(emails.requester)
      const items = await menu(requester)
      assert.equal(items.includes('Usuários'), false)
      assert.equal(items.includes('Auditoria'), false)
      assert.equal(items.includes('Configurações'), false)
      assert.equal(await requester.textContent('.user-info span'), 'Solicitante')

      for (const path of ['/usuarios', '/auditoria', '/configuracoes', '/cadastros-pendentes', '/calendario', '/relatorios']) {
        await requester.goto(path)
        await requester.waitForSelector('.access-denied')
      }

      await requester.goto('/manutencao/nova')
      await requester.waitForSelector('.maintenance-request-page')
    })

    await step('a API recusa o que a tela esconde', async () => {
      const status = await requester.evaluate(async () => (await fetch('/api/admin/users')).status)
      assert.equal(status, 403)
    })

    await step('operadora vê a identificação da SLM e não administra usuários', async () => {
      const operator = await login(emails.operator)
      assert.equal(await operator.textContent('.user-info span'), 'Operador SLM')
      assert.ok((await menu(operator)).includes('Calendário'))
      await operator.goto('/usuarios')
      await operator.waitForSelector('.access-denied')
    })

    requesterId = await requester.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id)

    async function setPermissions(changes) {
      await admin.goto(`/usuarios/${requesterId}`)
      await admin.waitForSelector('.users-permission')
      for (const [key, value] of Object.entries(changes)) {
        await admin.locator('.users-permission', { hasText: key }).locator('select').selectOption(value)
      }
      await admin.click('button:has-text("Salvar acesso")')
      await admin.waitForSelector('.page-section > [role=status]')
    }

    await step('settings:read deixa Configurações só em consulta', async () => {
      await setPermissions({ 'settings:read': 'grant' })
      await requester.goto('/configuracoes')
      await requester.waitForSelector('.settings-grid')
      const disabled = await requester.$$eval('.settings-card-actions button', (items) => items.every((item) => item.disabled))
      assert.equal(disabled, true)
      assert.equal(await requester.locator('.form-field-config-main').count(), 0)
    })

    await step('permissão retirada some da tela sem novo login', async () => {
      await requester.goto('/manutencao')
      await requester.waitForSelector('a:has-text("Nova solicitação")')
      await setPermissions({ 'maintenance:create': 'deny' })
      await requester.goto('/manutencao')
      await requester.waitForSelector('.maintenance-page')
      assert.equal(await requester.locator('a:has-text("Nova solicitação")').count(), 0)
      await requester.goto('/manutencao/nova')
      await requester.waitForSelector('.access-denied')
    })

    await step('permissão retirada com a tela aberta vira acesso negado', async () => {
      await setPermissions({ 'users:read': 'grant' })
      await requester.goto('/usuarios')
      await requester.waitForSelector('.users-filters')
      assert.equal(await requester.locator('.users-link').first().textContent(), 'Consultar')
      await setPermissions({ 'users:read': 'profile' })
      await requester.fill('.users-search input', 'x')
      await requester.click('.users-filters button')
      await requester.waitForSelector('.access-denied')
    })

    await step('a própria conta não oferece alteração de acesso', async () => {
      const id = await admin.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user.id)
      await admin.goto(`/usuarios/${id}`)
      await admin.waitForSelector('.users-note')
      assert.equal(await admin.locator('button:has-text("Salvar acesso")').count(), 0)
    })

    await step('nada sensível fica no armazenamento do navegador', async () => {
      const stored = await requester.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
      assert.doesNotMatch(stored, /cpf|csrf|permission/i)
    })

    await step('conta desativada volta ao login durante o uso', async () => {
      await admin.goto(`/usuarios/${requesterId}`)
      await admin.waitForSelector('button.danger')
      await admin.click('button.danger')
      await admin.waitForSelector('.page-section > [role=status]')
      await requester.click('.nav-item[title="Frota"]')
      await requester.waitForSelector('#login-identifier')
    })

    await step('sair encerra a sessão no servidor', async () => {
      await admin.click('.topbar-logout')
      await admin.waitForSelector('#login-identifier')
      const status = await admin.evaluate(async () => (await fetch('/api/auth/me')).status)
      assert.equal(status, 401)
    })

    await step('toda resposta da API veio do backend desta execução', async () => {
      assert.deepEqual(violations, [])
    })

    assert.deepEqual(pageErrors, [])
    if (blockedOrigins.size > 0) {
      console.log(`Origens externas bloqueadas no navegador: ${[...blockedOrigins].join(', ')}`)
    }
  } finally {
    await browser.close()
  }
}

module.exports = { run }
