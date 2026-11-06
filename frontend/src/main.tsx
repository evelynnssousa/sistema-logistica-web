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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
