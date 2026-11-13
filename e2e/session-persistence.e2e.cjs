/**
 * Permanência da sessão no navegador, incluindo as situações que derrubavam o acesso logo depois
 * do login (docs/AUDITORIA_SESSAO_LOGIN.md). Executado somente por scripts/run-browser-tests.cjs,
 * em banco descartável.
 */
const assert = require('node:assert/strict')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const requesterEmail = 'e2e-sessao-solicitante@slm-e2e.invalid'
const staleToken = 'A'.repeat(43)

async function run({ playwright, baseUrl, runId, password }) {
  const browser = await playwright.chromium.launch()
  try {
    await scenarios({ browser, baseUrl, runId, password })
  } finally {
    await browser.close()
  }
}

async function scenarios({ browser, baseUrl, runId, password }) {
  const baseOrigin = new URL(baseUrl).origin
  const host = new URL(baseUrl).hostname
  const violations = []

  async function newContext() {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } })
    context.setDefaultTimeout(20000)
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
    )
    context.on('response', (response) => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/') && response.headers()['x-slm-e2e-run'] !== runId) {
        violations.push(url.pathname)
      }
    })
    return context
  }

  async function fillLogin(target, email) {
    await target.locator('#login-identifier').fill(email)
    await target.locator('#login-password').fill(password)
    await target.locator('.login-submit').click()
  }

  async function step(name, action) {
    await action()
    console.log(`✔ ${name}`)
  }

  const sessionCookies = async (context) =>
    (await context.cookies()).filter((cookie) => cookie.name === 'slm_session')

  /** Sai do alcance de uma queda tardia: confere depois de as respostas pendentes chegarem. */
  async function assertStaysInside(page, context) {
    await page.waitForTimeout(2500)
    assert.equal(await page.locator('.topbar-logout').count(), 1, 'deveria continuar no sistema')
    assert.equal((await sessionCookies(context)).length, 1, 'o cookie de sessão deveria continuar')
  }

  // Conta comum, pelo fluxo real de cadastro e aprovação administrativa.
  async function prepareRequester() {
    const context = await newContext()
    const page = await context.newPage()
    const registered = await page.request.post('/api/auth/register', {
      data: {
        fullName: 'Solicitante Sessão E2E',
        email: requesterEmail,
        sector: 'Protocolo',
        password,
        passwordConfirmation: password,
      },
    })
    assert.equal(registered.status(), 202)

    await page.goto('/entrar')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    const approved = await page.evaluate(async (email) => {
      const me = await (await fetch('/api/auth/me')).json()
      const headers = { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }
      const pending = await (await fetch('/api/admin/registrations/pending')).json()
      const { id } = pending.registrations.find((item) => item.email === email)
      const result = await fetch(`/api/admin/registrations/${id}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: 'requester' }),
      })
      return result.status
    }, requesterEmail)
    assert.equal(approved, 200)
    await context.close()
  }

  await prepareRequester()

  for (const [label, email, administrator] of [
    ['administrador', adminEmail, true],
    ['usuário comum', requesterEmail, false],
  ]) {
    const context = await newContext()
    const page = await context.newPage()

    await step(`${label}: login com credenciais válidas e permanência`, async () => {
      await page.goto('/entrar')
      await fillLogin(page, email)
      await page.waitForSelector('.topbar-logout')
      await assertStaysInside(page, context)
    })

    await step(`${label}: atualizar a página não perde a autenticação`, async () => {
      await page.reload()
      await page.waitForSelector('.topbar-logout')
      await assertStaysInside(page, context)
    })

    await step(`${label}: navegar entre módulos não pede novo login`, async () => {
      for (const path of ['/manutencao', '/frota', '/passagens-aereas', '/almoxarifado', '/minha-conta', '/']) {
        await page.goto(path)
        await page.waitForSelector('.topbar-logout')
      }
      await page.click('.navigation a[href="/minha-conta"]')
      await page.waitForSelector('.topbar-logout')
      await assertStaysInside(page, context)
      if (administrator) assert.ok((await page.locator('.navigation a[href="/usuarios"]').count()) === 1)
      else assert.equal(await page.locator('.navigation a[href="/usuarios"]').count(), 0)
    })

    await step(`${label}: fechar e reabrir a página mantém a sessão`, async () => {
      await page.close()
      const reopened = await context.newPage()
      await reopened.goto('/entrar')
      await reopened.waitForSelector('.topbar-logout')
      await assertStaysInside(reopened, context)
    })

    await step(`${label}: logout manual encerra a sessão de verdade`, async () => {
      const current = context.pages()[0]
      const before = (await sessionCookies(context))[0]
      await current.click('.topbar-logout')
      await current.waitForSelector('#login-identifier')
      assert.equal((await sessionCookies(context)).length, 0)
      assert.equal(await current.locator('.login-error').count(), 0, 'logout não é um erro')

      // O mesmo token, reapresentado, não vale mais.
      const replay = await current.request.get('/api/auth/me', {
        headers: { cookie: `slm_session=${before.value}` },
      })
      assert.equal(replay.status(), 401)
    })

    await context.close()
  }

  await step('sem autenticação: nenhuma tela interna, e a API responde 401', async () => {
    const context = await newContext()
    const page = await context.newPage()
    // O endereço principal mostra a página inicial pública; os demais pedem login.
    await page.goto('/')
    await page.waitForSelector('.public-hero')
    assert.equal(await page.locator('.topbar-logout').count(), 0)
    for (const path of ['/manutencao', '/usuarios', '/central-slm']) {
      await page.goto(path)
      await page.waitForSelector('#login-identifier')
      assert.equal(await page.locator('.topbar-logout').count(), 0)
    }
    assert.equal((await page.request.get('/api/auth/me')).status(), 401)
    assert.equal((await page.request.get('/api/maintenance/requests')).status(), 401)
    await context.close()
  })

  await step('sessão encerrada durante o uso volta ao login com aviso', async () => {
    const context = await newContext()
    const page = await context.newPage()
    await page.goto('/entrar')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    await context.clearCookies()
    await page.click('.navigation a[href="/minha-conta"]')
    await page.waitForSelector('#login-identifier')
    assert.match(await page.locator('.login-error').innerText(), /sessão foi encerrada/)
    await context.close()
  })

  await step('falha momentânea da API não encerra a sessão', async () => {
    const context = await newContext()
    const page = await context.newPage()
    await page.goto('/entrar')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'x-slm-e2e-run': runId },
        body: '{"success":false}',
      }),
    )
    await page.click('.navigation a[href="/minha-conta"]')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.topbar-logout').count(), 1)
    await page.unroute('**/api/auth/me')
    await assertStaysInside(page, context)
    await context.close()
  })

  await step('a tela de login não consulta a sessão ao receber foco', async () => {
    const context = await newContext()
    const page = await context.newPage()
    await page.goto('/entrar')
    await page.waitForSelector('#login-identifier')
    let consultas = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/me') consultas += 1
    })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(300)
    assert.equal(consultas, 0)
    await context.close()
  })

  await step('resposta 401 atrasada, sem cookie, não apaga a sessão do login', async () => {
    const context = await newContext()
    const page = await context.newPage()
    // Uma consulta sem cookie sai antes do login e só chega depois dele.
    await page.goto('/entrar')
    await page.waitForSelector('#login-identifier')
    const slow = page.evaluate(async () => {
      const response = await fetch('/api/auth/me?atrasada=1')
      await response.text()
      return response.status
    })
    await page.route('**/api/auth/me?atrasada=1', async (route) => {
      const response = await route.fetch()
      await new Promise((done) => setTimeout(done, 1500))
      await route.fulfill({ response })
    })
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    assert.equal(await slow, 401)
    await assertStaysInside(page, context)
    await context.close()
  })

  await step('uma consulta anterior ao logout não traz a pessoa de volta', async () => {
    const context = await newContext()
    const page = await context.newPage()
    await page.goto('/entrar')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    await page.route('**/api/auth/me', async (route) => {
      const response = await route.fetch()
      await new Promise((done) => setTimeout(done, 1200))
      await route.fulfill({ response })
    })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.click('.topbar-logout')
    await page.waitForSelector('#login-identifier')
    await page.waitForTimeout(1800)
    assert.equal(await page.locator('.topbar-logout').count(), 0)
    await context.close()
  })

  await step('cookie antigo no mesmo caminho é substituído pelo login', async () => {
    const context = await newContext()
    await context.addCookies([
      { name: 'slm_session', value: staleToken, domain: host, path: '/', httpOnly: true, sameSite: 'Strict' },
    ])
    const page = await context.newPage()
    await page.goto('/entrar')
    await page.waitForSelector('#login-identifier')
    assert.equal((await sessionCookies(context)).length, 0, 'o cookie inválido é limpo')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.topbar-logout')
    await assertStaysInside(page, context)
    await context.close()
  })

  await step('cookies duplicados continuam recusados, e a tela explica o que fazer', async () => {
    const context = await newContext()
    await context.addCookies([
      { name: 'slm_session', value: staleToken, domain: host, path: '/api', httpOnly: true, sameSite: 'Strict' },
    ])
    const page = await context.newPage()
    await page.goto('/entrar')
    await page.waitForSelector('#login-identifier')
    await fillLogin(page, adminEmail)
    await page.waitForSelector('.login-error')
    assert.match(await page.locator('.login-error').innerText(), /apague cookies antigos/)
    assert.equal(await page.locator('.topbar-logout').count(), 0)
    await context.close()
  })

  await step('embutido em outro site: o cookie continua recusado, e a tela explica como abrir', async () => {
    const context = await newContext()
    // Outro site de verdade para o navegador, mesmo sendo a mesma máquina. A página é simulada aqui.
    const otherSite = baseUrl.replace(host, host === 'localhost' ? '127.0.0.1' : 'localhost')
    await context.route(`${otherSite}/`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><iframe id="app" src="${baseUrl}/entrar" style="width:1200px;height:800px"></iframe>`,
      }),
    )
    // O servidor de desenvolvimento não proíbe a página embutida; a tela de teste, sim.
    await context.route(`${baseUrl}/entrar`, async (route) => {
      const response = await route.fetch()
      const headers = { ...response.headers() }
      delete headers['x-frame-options']
      delete headers['content-security-policy']
      await route.fulfill({ response, headers })
    })
    const page = await context.newPage()
    await page.goto(`${otherSite}/`)
    const frame = page.frameLocator('#app')
    await frame.locator('#login-identifier').waitFor()
    await fillLogin(frame, adminEmail)
    await frame.locator('.login-error').waitFor()
    assert.match(await frame.locator('.login-error').innerText(), /aba própria/)
    assert.equal((await sessionCookies(context)).length, 0)
    await context.close()
  })

  assert.deepEqual(violations, [], 'resposta fora desta execução')
}

module.exports = { run }
