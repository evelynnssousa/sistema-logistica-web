/**
 * Matriz de permissões do Controle de Demandas no navegador, para os quatro perfis: o que cada um
 * vê, quais botões aparecem e o que a API recusa por chamada direta.
 * Executado somente por scripts/run-browser-tests.cjs, em banco descartável.
 */
const assert = require('node:assert/strict')
const { join } = require('node:path')

const adminEmail = 'e2e-admin@slm-e2e.invalid'
const emails = {
  servidor: 'e2e-matriz-servidor@slm-e2e.invalid',
  chefe: 'e2e-matriz-chefe@slm-e2e.invalid',
  diretor: 'e2e-matriz-diretor@slm-e2e.invalid',
}
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const editButtons = ['Alterar status', 'Concluir', 'Cancelar', 'Distribuir', 'Colaboração']

async function run({ playwright, baseUrl, runId, password, screenshotDirectory }) {
  const browser = await playwright.chromium.launch({ args: ['--disable-dev-shm-usage'] })
  const origin = new URL(baseUrl).origin
  const violations = []
  const pageErrors = []

  async function login(email) {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } })
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
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `matriz-${name}.png`), fullPage: true })
  }
  const plusDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

  try {
    const admin = await login(adminEmail)
    const ids = {}
    // As contas vêm prontas do executor, sem gastar o limite de cadastros por IP.
    for (const email of Object.values(emails)) {
      const found = await api(admin, 'GET', `/admin/users?search=${encodeURIComponent(email)}`)
      ids[email] = found.body.users[0].id
    }

    const sectorA = (await api(admin, 'POST', '/demands/settings/sectors', { name: 'Matriz Alfa' })).body.id
    const sectorB = (await api(admin, 'POST', '/demands/settings/sectors', { name: 'Matriz Beta' })).body.id
    await api(admin, 'PUT', `/demands/settings/sectors/${sectorA}/members/${ids[emails.servidor]}`, { role: 'colaborador' })
    await api(admin, 'PUT', `/demands/settings/sectors/${sectorA}/members/${ids[emails.chefe]}`, { role: 'responsavel', chefia: true })
    await api(admin, 'PUT', `/demands/settings/directorate/${ids[emails.diretor]}`, { role: 'diretor' })

    const servidor = await login(emails.servidor)
    const chefe = await login(emails.chefe)
    const diretor = await login(emails.diretor)

    const categoryId = (await api(diretor, 'GET', '/demands/options')).body.categories[0].id
    const body = (title, sectorId, extra = {}) => ({
      title, description: 'Demanda de teste.', categoryId, originSectorId: sectorId, responsibleSectorId: sectorId, dueDate: plusDays(10), ...extra,
    })
    const inA = (await api(diretor, 'POST', '/demands', body('Matriz demanda Alfa', sectorA, { responsibleId: ids[emails.servidor] }))).body
    const inB = (await api(diretor, 'POST', '/demands', body('Matriz demanda Beta', sectorB))).body
    assert.ok(inA.id && inB.id)

    async function assertConsultation(page, id) {
      await page.goto(`/demandas/${id}`)
      await page.waitForSelector('text=Modo de consulta')
      for (const name of editButtons) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, name)
      assert.equal(await page.getByRole('link', { name: 'Editar' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Registrar' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Nova etapa' }).count(), 0)
      await page.waitForSelector('.demand-summary >> text=Matriz Alfa')
    }
    async function assertEditable(page, id) {
      await page.goto(`/demandas/${id}`)
      await page.getByRole('button', { name: 'Alterar status' }).waitFor()
      await page.getByRole('link', { name: 'Editar' }).waitFor()
      await page.getByRole('button', { name: 'Distribuir' }).waitFor()
      assert.equal(await page.locator('text=Modo de consulta').count(), 0)
    }
    const directWrites = async (page, id) => [
      await api(page, 'PATCH', `/demands/${id}`, { dueDate: plusDays(40) }),
      await api(page, 'POST', `/demands/${id}/status`, { status: 'em_andamento' }),
      await api(page, 'POST', `/demands/${id}/assign`, { responsibleId: null }),
      await api(page, 'POST', `/demands/${id}/comments`, { text: 'Tentativa' }),
      await api(page, 'POST', `/demands/${id}/cancel`, { reason: 'Tentativa' }),
    ].map((item) => item.status)

    await step('atalho da aba Inicial: um clique abre o formulário, com só os setores permitidos', async () => {
      await servidor.goto('/')
      const shortcut = servidor.locator('.home-actions .home-action', { hasText: 'Criar demanda' })
      await shortcut.waitFor()
      await shot(servidor, 'inicio-atalho')
      await shortcut.click()
      await servidor.waitForURL(/\/demandas\/nova$/)
      const form = servidor.locator('.demand-form')
      await form.waitFor()
      assert.deepEqual(await form.getByLabel('Setor responsável').locator('option').allTextContents(), ['Selecione', 'Matriz Alfa'])
      assert.deepEqual(await form.getByLabel('Setor de origem').locator('option').allTextContents(), ['Selecione', 'Matriz Alfa'])

      await diretor.goto('/')
      await diretor.locator('.home-actions .home-action', { hasText: 'Criar demanda' }).click()
      await diretor.locator('.demand-form').waitFor()
      const all = await diretor.locator('.demand-form').getByLabel('Setor responsável').locator('option').allTextContents()
      assert.ok(all.includes('Matriz Alfa') && all.includes('Matriz Beta'))

      // O administrador sem perfil de Diretor não cadastra, e o atalho não aparece.
      await admin.goto('/')
      await admin.waitForSelector('.recent-section')
      await admin.waitForFunction(() => document.querySelector('.navigation a[href="/demandas"]'))
      assert.equal(await admin.locator('.home-action', { hasText: 'Criar demanda' }).count(), 0)
    })

    await step('servidor: vê só o setor, cadastra para ele e edita as demandas dele', async () => {
      await servidor.goto('/demandas/todas')
      await servidor.waitForSelector('[data-testid="demand-profile"] >> text=Servidor do setor (Matriz Alfa)')
      await servidor.waitForSelector('.demand-table >> text=Matriz demanda Alfa')
      assert.equal(await servidor.locator('text=Matriz demanda Beta').count(), 0)
      await shot(servidor, 'servidor-lista')
      await assertEditable(servidor, inA.id)
      await shot(servidor, 'servidor-detalhe')

      await servidor.goto(`/demandas/${inA.id}/editar`)
      const edit = servidor.locator('.demand-form')
      await edit.waitFor()
      assert.equal(await edit.getByLabel('Setor responsável').isDisabled(), true, 'só o Diretor transfere')
      await edit.getByLabel('Prazo para conclusão').fill(plusDays(12))
      await edit.getByRole('button', { name: /Salvar/ }).first().click()
      await servidor.waitForURL(new RegExp(`/demandas/${inA.id}$`))
      await servidor.waitForSelector('.demand-history >> text=Prazo alterado')

      assert.equal((await api(servidor, 'GET', `/demands/${inB.id}`)).status, 404)
      assert.equal((await api(servidor, 'PATCH', `/demands/${inB.id}`, { title: 'Invasão' })).status, 404)
      assert.equal((await api(servidor, 'POST', `/demands/${inB.id}/status`, { status: 'em_andamento' })).status, 404)
      assert.equal((await api(servidor, 'POST', '/demands', body('Outro setor', sectorB))).status, 403)

      await servidor.goto('/demandas/nova')
      const form = servidor.locator('.demand-form')
      await form.getByLabel('Título').fill('Matriz cadastrada pelo servidor')
      await form.getByLabel('Descrição detalhada').fill('Com anexo no cadastro.')
      await form.getByLabel('Categoria').selectOption({ index: 1 })
      await form.getByLabel('Prazo para conclusão').fill(plusDays(4))
      await form.locator('input[type="file"]').setInputFiles({ name: 'do-servidor.pdf', mimeType: 'application/pdf', buffer: pdf })
      await shot(servidor, 'servidor-cadastro')
      await form.getByRole('button', { name: 'Cadastrar demanda' }).click()
      await servidor.waitForURL(/\/demandas\/[0-9a-f-]{36}$/)
      await servidor.waitForSelector('.demand-attachments >> text=do-servidor.pdf')
      const registered = await api(servidor, 'GET', `/demands/${servidor.url().split('/').pop()}`)
      assert.equal(registered.body.demand.draft, false)
      assert.equal(registered.body.access.edit, true)
    })

    await step('pesquisa: filtros combináveis, recolhidos, sem revelar outro setor, e limpar volta à lista', async () => {
      await servidor.goto('/demandas/todas')
      await servidor.waitForSelector('.demand-table >> text=Matriz demanda Alfa')
      const rows = servidor.locator('.demand-table tbody tr')
      const original = await rows.count()
      assert.equal(await servidor.getByLabel('Solicitante').count(), 0, 'os filtros menos usados começam recolhidos')
      assert.deepEqual(await servidor.getByLabel('Setor').locator('option').allTextContents(), ['Todos os setores', 'Matriz Alfa'])
      await shot(servidor, 'pesquisa-recolhida')

      await servidor.getByRole('searchbox', { name: 'Número/protocolo' }).fill(inB.number)
      await servidor.waitForSelector('text=Nenhuma demanda encontrada')
      await servidor.getByRole('searchbox', { name: 'Número/protocolo' }).fill(inA.number)
      await rows.first().waitFor()
      assert.equal(await rows.count(), 1)
      await servidor.getByRole('button', { name: 'Limpar filtros' }).click()
      await servidor.waitForFunction((total) => document.querySelectorAll('.demand-table tbody tr').length === total, original)

      await servidor.getByRole('searchbox', { name: 'Título e descrição' }).fill('Matriz')
      await servidor.getByRole('button', { name: 'Mais filtros' }).click()
      await servidor.getByLabel('Solicitante').fill('matriz diretor')
      await servidor.getByLabel('Status').selectOption('nao_iniciada')
      await servidor.getByLabel('Só atrasadas').check()
      await servidor.waitForSelector('text=Nenhuma demanda encontrada')
      await servidor.getByRole('button', { name: /Menos filtros \(2\)/ }).waitFor()
      await shot(servidor, 'pesquisa-aberta')
      await servidor.getByLabel('Só atrasadas').uncheck()
      await servidor.waitForSelector('.demand-table >> text=Matriz demanda Alfa')
      await servidor.getByRole('button', { name: 'Limpar filtros' }).click()
      await servidor.waitForFunction((total) => document.querySelectorAll('.demand-table tbody tr').length === total, original)

      // Limpar também desfaz a ordenação e os filtros que vieram de um link do painel.
      await servidor.goto('/demandas/todas?overdue=true')
      await servidor.waitForSelector('text=Nenhuma demanda encontrada')
      await servidor.getByLabel('Ordenar por').selectOption('prazo')
      await servidor.getByRole('button', { name: 'Limpar filtros' }).click()
      await servidor.waitForFunction((total) => document.querySelectorAll('.demand-table tbody tr').length === total, original)
      assert.equal(new URL(servidor.url()).search, '')
      assert.equal(await servidor.getByLabel('Ordenar por').inputValue(), 'atualizacao')

      // O Diretor encontra o que o servidor não alcança.
      await diretor.goto('/demandas/todas')
      await diretor.getByRole('searchbox', { name: 'Número/protocolo' }).fill(inB.number)
      await diretor.waitForSelector('.demand-table >> text=Matriz demanda Beta')

      // Celular: sem rolagem lateral, com os filtros abertos ou fechados.
      for (const page of [servidor, diretor]) await page.setViewportSize({ width: 390, height: 800 })
      await servidor.goto('/demandas/todas')
      await servidor.waitForSelector('.demand-table')
      const overflow = () => servidor.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok((await overflow()) <= 1, 'filtros recolhidos')
      await servidor.getByRole('button', { name: 'Mais filtros' }).click()
      assert.ok((await overflow()) <= 1, 'filtros abertos')
      await shot(servidor, 'pesquisa-celular')
      await servidor.goto('/')
      await servidor.locator('.home-action', { hasText: 'Criar demanda' }).waitFor()
      assert.ok((await overflow()) <= 1, 'aba Inicial')
      for (const page of [servidor, diretor]) await page.setViewportSize({ width: 1360, height: 900 })
    })

    await step('chefe: vê e edita o próprio setor, sem alcançar os outros', async () => {
      await chefe.goto('/demandas/todas')
      await chefe.waitForSelector('[data-testid="demand-profile"] >> text=Chefe do setor (Matriz Alfa)')
      assert.equal(await chefe.locator('text=Matriz demanda Beta').count(), 0)
      await assertEditable(chefe, inA.id)
      await shot(chefe, 'chefe-detalhe')
      await chefe.goto(`/demandas/${inA.id}/editar`)
      await chefe.waitForSelector('.demand-form')
      assert.equal(await chefe.locator('.demand-form').getByLabel('Setor responsável').isDisabled(), true, 'só o Diretor transfere')
      await shot(chefe, 'chefe-edicao')
      assert.equal((await api(chefe, 'GET', `/demands/${inB.id}`)).status, 404)
      assert.equal((await api(chefe, 'POST', `/demands/${inB.id}/status`, { status: 'em_andamento' })).status, 404)
      assert.equal((await api(chefe, 'POST', '/demands', body('Outro setor', sectorB))).status, 403)
      assert.equal((await api(chefe, 'POST', `/demands/${inA.id}/status`, { status: 'em_andamento' })).status, 200)
      await chefe.goto('/demandas/relatorios')
      await chefe.waitForSelector('text=Relatórios')
    })

    await step('diretor: vê, cadastra e edita em todos os setores', async () => {
      await diretor.goto('/demandas/todas')
      await diretor.waitForSelector('[data-testid="demand-profile"] >> text=Diretor da Diretoria Administrativa')
      await diretor.waitForSelector('.demand-table >> text=Matriz demanda Alfa')
      await diretor.waitForSelector('.demand-table >> text=Matriz demanda Beta')
      await shot(diretor, 'diretor-lista')
      await assertEditable(diretor, inB.id)
      assert.equal((await api(diretor, 'POST', `/demands/${inB.id}/status`, { status: 'em_andamento' })).status, 200)
      assert.equal((await api(diretor, 'POST', '/demands', body('Do diretor', sectorB))).status, 201)
    })

    await step('administrador: consulta tudo e toda alteração é bloqueada', async () => {
      await admin.goto('/demandas/todas')
      await admin.waitForSelector('[data-testid="demand-profile"] >> text=Somente consulta')
      await admin.waitForSelector('.demand-table >> text=Matriz demanda Alfa')
      await admin.waitForSelector('.demand-table >> text=Matriz demanda Beta')
      assert.equal(await admin.locator('a:has-text("Nova demanda")').count(), 0)
      await shot(admin, 'administrador-lista')
      await assertConsultation(admin, inA.id)
      await shot(admin, 'administrador-detalhe')
      assert.equal(await admin.getByRole('button', { name: 'Acompanhar' }).count(), 0)
      assert.deepEqual(await directWrites(admin, inA.id), [403, 403, 403, 403, 403])
      assert.equal((await api(admin, 'POST', '/demands', body('Do administrador', sectorA))).status, 403)

      // No quadro, o administrador vê os cartões e não tem como movê-los.
      await admin.goto('/demandas/todas')
      await admin.getByRole('button', { name: 'Quadro' }).click()
      await admin.locator('.demand-card', { hasText: 'Matriz demanda Alfa' }).waitFor()
      assert.equal(await admin.locator('.demand-card select').count(), 0)
      assert.equal(await admin.locator('.demand-card[draggable="true"]').count(), 0)
      await admin.waitForSelector('text=o quadro não permite mover demandas')
      await shot(admin, 'administrador-quadro')
    })

    await step('setor colaborador: o servidor edita a demanda compartilhada, inclusive no quadro, e não a transfere', async () => {
      const fromBeta = (await api(diretor, 'POST', '/demands', body('Matriz colaboração Beta', sectorB, { collaboratorSectorIds: [sectorA] }))).body
      assert.ok(fromBeta.id)
      await servidor.goto('/demandas/todas')
      await servidor.getByRole('button', { name: 'Quadro' }).click()
      for (const title of ['Matriz demanda Alfa', 'Matriz colaboração Beta']) {
        const card = servidor.locator('.demand-card', { hasText: title })
        await card.locator('select').waitFor()
        assert.equal(await card.getAttribute('draggable'), 'true')
      }
      await assertEditable(servidor, fromBeta.id)
      assert.equal((await api(servidor, 'POST', `/demands/${fromBeta.id}/status`, { status: 'em_andamento' })).status, 200)
      assert.equal((await api(servidor, 'PATCH', `/demands/${fromBeta.id}`, { responsibleSectorId: sectorA })).status, 403)
      assert.equal((await api(servidor, 'PATCH', `/demands/${inB.id}`, { title: 'Invasão' })).status, 404, 'sem vínculo com o setor, nem alcança')
    })

    await step('diretor: configura setores, integrantes e categorias pela tela, sem definir diretores', async () => {
      await diretor.goto('/')
      await diretor.locator('.navigation a[href="/configuracoes"]').click()
      await diretor.getByRole('heading', { name: 'Setores e integrantes' }).waitFor()
      assert.equal(await diretor.getByRole('heading', { name: /Diretor/ }).count(), 0, 'o painel de diretores é do administrador')
      await shot(diretor, 'diretor-configuracoes')
      assert.equal((await api(diretor, 'POST', '/demands/settings/categories', { name: 'Categoria Matriz' })).status, 201)
      assert.equal((await api(diretor, 'PUT', `/demands/settings/directorate/${ids[emails.chefe]}`, { role: 'diretor' })).status, 403)

      await servidor.goto('/')
      await servidor.waitForSelector('.navigation a[href="/demandas"]')
      assert.equal(await servidor.locator('.navigation a[href="/configuracoes"]').count(), 0)
      assert.equal((await api(servidor, 'GET', '/demands/settings/sectors')).status, 403)
      await chefe.goto('/configuracoes')
      await chefe.waitForSelector('.navigation a[href="/demandas"]')
      assert.equal(await chefe.getByRole('heading', { name: 'Setores e integrantes' }).count(), 0)
      assert.equal((await api(chefe, 'POST', '/demands/settings/categories', { name: 'Sem poder' })).status, 403)
    })

    await step('as alterações ficam na auditoria, com usuário, data, horário e o que mudou', async () => {
      const audit = await api(admin, 'GET', '/admin/audit?action=demand.changed')
      assert.equal(audit.status, 200, JSON.stringify(audit.body))
      const text = JSON.stringify(audit.body)
      assert.ok(text.includes('prazo alterado'))
      assert.ok(text.includes(inA.number))
      await admin.goto('/auditoria')
      await admin.waitForSelector('text=Demanda alterada')
      await shot(admin, 'auditoria')
    })

    assert.deepEqual(violations, [], 'resposta de outro backend')
    assert.deepEqual(pageErrors, [], 'erro na página')
  } finally {
    await browser.close()
  }
}

module.exports = { run }
