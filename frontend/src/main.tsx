import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonte Inter servida pelo próprio sistema, sem requisição ao Google (auditoria, P-17).
// O subconjunto latino cobre os acentos do português.
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/inter/latin-800.css'
import './index.css'
import App from './App.tsx'

/*
 * Depois de uma nova publicação, quem estava com a versão anterior aberta pode pedir uma tela que
 * não existe mais (os arquivos têm o resumo no nome). Recarrega uma vez para buscar a versão nova;
 * se a falha se repetir em pouco tempo, deixa o erro aparecer, para não entrar em ciclo.
 */
window.addEventListener('vite:preloadError', (event) => {
  const key = 'slm-reload-after-update'
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
