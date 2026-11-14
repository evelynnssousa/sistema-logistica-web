/**
 * Robô de atas pelo Excel (14/11/2026): o modelo baixado e preenchido abre a nova ata já preenchida,
 * e os itens entram junto ao salvar; numa ata existente, "Importar itens do Excel" acrescenta itens.
 * Executado somente por scripts/run-browser-tests.cjs. Dados fictícios, no banco descartável.
 */
const assert = require('node:assert/strict')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const memberEmail = 'e2e-atas-excel@slm-e2e.invalid'

async function run({ playwright, baseUrl, password }) {
  const browser = await playwright.chromium.launch()
  const baseOrigin = new URL(baseUrl).origin
  const pageErrors = []

  async function login(email) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 }, acceptDownloads: true })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
    )
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
          headers: { 'content-type': 'application/json', ...(me.csrfToken ? { 'x-csrf-token': me.csrfToken } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: response.status, body: await response.json().catch(() => ({})) }
      },
      { method, path, body },
    )

  try {
    // Integrante do setor "Almoxarifado" no Controle de Demandas, que pode cadastrar atas.
    const admin = await login(adminEmail)
    const registered = await admin.evaluate(
      async ({ email, password }) =>
        (await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fullName: 'Pessoa das Atas', email, sector: 'Almoxarifado', password, passwordConfirmation: password }),
        })).status,
      { email: memberEmail, password },
    )
    assert.equal(registered, 202)
    const pending = (await api(admin, 'GET', '/admin/registrations/pending')).body.registrations
    const userId = pending.find((item) => item.email === memberEmail).id
    assert.equal((await api(admin, 'POST', `/admin/registrations/${userId}/approve`, { role: 'requester' })).status, 200)
    const sector = await api(admin, 'POST', '/demands/settings/sectors', { name: 'Almoxarifado' })
    assert.equal(sector.status, 201, JSON.stringify(sector.body))
    assert.equal((await api(admin, 'PUT', `/demands/settings/sectors/${sector.body.id}/members/${userId}`, { role: 'colaborador' })).status, 200)

    const member = await login(memberEmail)
    await member.goto('/demandas/atas')
    const download = member.waitForEvent('download')
    await member.click('text=Baixar modelo em Excel')
    const template = await (await download).path()

    await member.locator('label', { hasText: 'Importar do Excel' }).locator('input[type=file]').setInputFiles(template)
    await member.waitForURL('**/demandas/atas/nova')
    await member.locator('text=Itens que serão cadastrados junto').waitFor()
    const form = member.locator('#instrument-form-title').locator('..')
    assert.equal(await form.getByLabel('Número').inputValue(), '12/2026')
    assert.equal(await form.getByLabel('Fornecedor').inputValue(), 'Papelaria Exemplo Ltda.')
    assert.match(await member.textContent('body'), /2 itens lidos da planilha/)
    await member.click('button[type=submit]')
    await member.waitForURL(/\/demandas\/atas\/[0-9a-f-]{36}$/)
    await member.locator('text=Caneta esferográfica azul').first().waitFor()

    const id = member.url().split('/').pop()
    assert.equal((await api(member, 'GET', `/demand-instruments/${id}`)).body.instrument.items.length, 2)

    // Na ata já criada, a mesma planilha acrescenta os itens de novo, depois de conferidos.
    await member.locator('label', { hasText: 'Importar itens do Excel' }).locator('input[type=file]').setInputFiles(template)
    await member.locator('.ui-modal').getByRole('button', { name: 'Cadastrar 2 itens' }).click()
    await member.locator('text=2 itens cadastrados.').waitFor()
    assert.equal((await api(member, 'GET', `/demand-instruments/${id}`)).body.instrument.items.length, 4)

    assert.deepEqual(pageErrors, [])
    console.log('✔ robô de atas: modelo, nova ata preenchida pelo Excel e itens importados numa ata existente')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
