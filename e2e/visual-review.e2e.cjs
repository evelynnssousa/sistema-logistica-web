/**
 * Revisão visual automática, nos tamanhos de computador, tablet e celular: sem rolagem
 * lateral, contraste de texto, nomes acessíveis e tamanho de alvos. Roda por último, com os
 * dados fictícios criados pelos cenários anteriores, em scripts/run-browser-tests.cjs.
 */
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const adminEmail = 'e2e-admin@slm-e2e.invalid'

const viewports = [
  { name: 'computador', width: 1360, height: 900 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'celular', width: 390, height: 844 },
]

const pages = [
  ['inicio', '/'],
  ['dashboard', '/dashboard'],
  ['manutencao', '/manutencao'],
  ['manutencao-nova', '/manutencao/nova'],
  ['frota', '/frota'],
  ['frota-nova', '/frota/nova'],
  ['passagens', '/passagens-aereas'],
  ['passagens-nova', '/passagens-aereas/nova'],
  ['almoxarifado', '/almoxarifado'],
  ['almoxarifado-solicitacoes', '/almoxarifado/solicitacoes'],
  ['almoxarifado-nova', '/almoxarifado/nova'],
  ['almoxarifado-externo', '/almoxarifado/externo'],
  ['almoxarifado-materiais', '/almoxarifado/materiais'],
  ['almoxarifado-inventario', '/almoxarifado/inventario'],
  ['almoxarifado-relatorios', '/almoxarifado/relatorios'],
  ['calendario', '/calendario'],
  ['relatorios', '/relatorios'],
  ['configuracoes', '/configuracoes'],
  ['usuarios', '/usuarios'],
  ['cadastros', '/cadastros-pendentes'],
  ['auditoria', '/auditoria'],
  ['integracoes', '/integracoes'],
  ['notificacoes', '/notificacoes'],
  ['conta', '/minha-conta'],
  ['pesquisa', '/pesquisa?q=manutencao'],
  ['monitoramento', '/monitoramento'],
  ['veiculos', '/frota/veiculos'],
  ['equipamentos', '/manutencao/equipamentos'],
  ['estoque', '/almoxarifado/estoque'],
  ['revisao-acessos', '/usuarios/revisao-de-acessos'],
]

const details = [
  ['manutencao-detalhe', '/manutencao', '.service-row-action', '.request-detail-page'],
  ['frota-detalhe', '/frota', '.service-row-action', '.request-detail-page'],
  ['passagens-detalhe', '/passagens-aereas', '.service-row-action', '.request-detail-page'],
  ['pedido-detalhe', '/almoxarifado/solicitacoes', '.data-table a', '.warehouse-request-page'],
  ['conferencia-detalhe', '/almoxarifado/inventario', '.data-table a', '.detail-status'],
  ['usuario-detalhe', '/usuarios', '.users-link', '.users-permission'],
]

const removedTexts = ['GESTÃO OPERACIONAL', 'Versão inicial', 'plataforma em desenvolvimento', 'Nova plataforma']

/** Executado dentro da página. Devolve o que estiver fora do padrão, sem alterar nada. */
function auditPage() {
  const problems = []
  const channel = (value) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  const parse = (color) => {
    const parts = color.match(/[\d.]+/g).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
  }
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })
  const backgroundOf = (element) => {
    const layers = []
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color.a > 0) {
        layers.push(color)
        if (color.a === 1) break
      }
    }
    return layers.reduceRight((below, layer) => blend(layer, below), { r: 255, g: 255, b: 255, a: 1 })
  }
  const isVisible = (element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 1 && box.height > 1
  }

  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    problems.push(`rolagem lateral: ${document.documentElement.scrollWidth}px em ${window.innerWidth}px`)
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const seen = new Set()
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.trim()
    const element = walker.currentNode.parentElement
    if (!text || !element || ['OPTION', 'SCRIPT', 'STYLE'].includes(element.tagName)) continue
    if (element.closest('.visually-hidden, [disabled], .ui-column-tooltip') || !isVisible(element)) continue

    const style = getComputedStyle(element)
    const size = parseFloat(style.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
    const background = backgroundOf(element)
    const foreground = blend(parse(style.color), background)
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    const ratio = (light + 0.05) / (dark + 0.05)
    if (ratio < (large ? 3 : 4.5)) {
      const label = `contraste ${ratio.toFixed(2)} em "${text.slice(0, 30)}" (${element.className || element.tagName})`
      if (!seen.has(label)) problems.push(label)
      seen.add(label)
    }
  }

  for (const control of document.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')) {
    if (!isVisible(control) || control.getAttribute('aria-hidden') === 'true') continue
    const box = control.getBoundingClientRect()
    const name = (
      control.getAttribute('aria-label') ||
      control.textContent ||
      control.labels?.[0]?.textContent ||
      control.getAttribute('title') ||
      control.getAttribute('alt') ||
      ''
    ).trim()
    if (!name) problems.push(`sem nome acessível: ${control.tagName} ${control.className}`)
    const inline = control.tagName === 'A' && getComputedStyle(control).display === 'inline'
    if (!inline && !['checkbox', 'radio'].includes(control.type) && (box.height < 24 || box.width < 24)) {
      problems.push(`alvo pequeno (${Math.round(box.width)}x${Math.round(box.height)}): ${name.slice(0, 30)}`)
    }
  }

  return [...new Set(problems)]
}

async function run({ playwright, baseUrl, password, screenshotDirectory }) {
  const browser = await playwright.chromium.launch()
  const baseOrigin = new URL(baseUrl).origin
  const failures = []
  if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true })

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        baseURL: baseUrl,
        viewport: { width: viewport.width, height: viewport.height },
      })
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort(),
      )
      const page = await context.newPage()
      await page.goto('/')
      await page.waitForSelector('#login-identifier')
      for (const problem of await page.evaluate(auditPage)) {
        failures.push(`${viewport.name} entrada: ${problem}`)
      }
      if (screenshotDirectory) {
        await page.screenshot({ path: join(screenshotDirectory, `${viewport.name}-entrada.png`) })
      }
      await page.fill('#login-identifier', adminEmail)
      await page.fill('#login-password', password)
      await page.click('.login-submit')
      await page.waitForSelector('.topbar-logout')

      for (const [name, path] of pages) {
        await page.goto(path)
        await page.waitForSelector('.page-content h1')
        await page.waitForFunction(() => !document.querySelector('.ui-loading, .ui-spinner'))
        await page.waitForTimeout(150)

        const text = await page.textContent('body')
        for (const removed of removedTexts) {
          if (text.includes(removed)) failures.push(`${viewport.name} ${path}: ainda mostra "${removed}"`)
        }
        for (const problem of await page.evaluate(auditPage)) {
          failures.push(`${viewport.name} ${path}: ${problem}`)
        }
        if (screenshotDirectory) {
          await page.screenshot({
            path: join(screenshotDirectory, `${viewport.name}-${name}.png`),
            fullPage: true,
          })
        }
      }

      // Telas de registro: abertas a partir das listas, porque os endereços mudam a cada execução.
      for (const [name, listPath, linkSelector, marker] of details) {
        await page.goto(listPath)
        await page.locator(linkSelector).first().click()
        await page.waitForSelector(marker)
        await page.waitForFunction(() => !document.querySelector('.ui-loading, .ui-spinner'))
        for (const problem of await page.evaluate(auditPage)) {
          failures.push(`${viewport.name} ${name}: ${problem}`)
        }
        if (screenshotDirectory) {
          await page.screenshot({ path: join(screenshotDirectory, `${viewport.name}-${name}.png`), fullPage: true })
        }
      }

      // No computador, a coluna de ações das listas cabe sem rolar a tabela.
      if (viewport.width >= 1024) {
        for (const path of ['/manutencao', '/frota', '/passagens-aereas']) {
          await page.goto(path)
          const wrapper = page.locator('.maintenance-table-wrapper')
          await wrapper.waitFor()
          const fits = await wrapper.evaluate((element) => element.scrollWidth <= element.clientWidth)
          if (!fits) failures.push(`${viewport.name} ${path}: a tabela exige rolagem lateral`)
        }
      }

      // Navegação da largura atual: fixa no computador, gaveta nos demais.
      await page.goto('/')
      await page.waitForSelector('.page-content h1')
      if (viewport.width < 1024) {
        const link = page.locator('.nav-item', { hasText: 'Dashboard' })
        assert.equal(await link.isVisible(), false, 'gaveta começa fechada')
        await page.click('.topbar-menu')
        await link.waitFor()
        await page.waitForTimeout(250)
        assert.equal(await link.locator('.nav-label').isVisible(), true, 'o nome do item aparece na gaveta')
        if (screenshotDirectory) {
          await page.screenshot({ path: join(screenshotDirectory, `${viewport.name}-menu.png`) })
        }
        for (const problem of await page.evaluate(auditPage)) {
          failures.push(`${viewport.name} menu aberto: ${problem}`)
        }
        await page.keyboard.press('Escape')
        await link.waitFor({ state: 'hidden' })
        await page.click('.topbar-menu')
        await link.click()
        await page.waitForURL('**/dashboard')
        await link.waitFor({ state: 'hidden' })
      } else {
        await page.keyboard.press('Tab')
        const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
        assert.equal(outline, 'solid', 'foco visível ao navegar pelo teclado')
        const active = page.locator('.nav-item.active')
        const colors = await active.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          icon: getComputedStyle(element.querySelector('.nav-icon')).color,
        }))
        assert.deepEqual(colors, { background: 'rgb(251, 185, 0)', icon: 'rgb(0, 0, 0)' })
      }

      console.log(`✔ revisão visual em ${viewport.name}: ${pages.length} telas`)
      await context.close()
    }

    assert.deepEqual(failures, [], `Problemas visuais:\n${failures.join('\n')}`)
  } finally {
    await browser.close()
  }
}

module.exports = { run, auditPage }
