import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const port = Number(process.env.SLM_FRONTEND_PORT) || 5173
const {
  API_PROXY_TARGET,
  E2E_RUN_ID,
  CODESPACE_NAME,
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
} = process.env

// No GitHub Codespaces a tela é aberta por um endereço encaminhado, que o Vite
// bloqueia por padrão. Libera somente o endereço deste Codespace.
const codespaceHost =
  CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : undefined

// Em teste de navegador, o destino é obrigatório e nunca é a API do desenvolvimento.
if (E2E_RUN_ID) {
  const target = API_PROXY_TARGET ? new URL(API_PROXY_TARGET) : null
  if (
    !target ||
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.port === '3000'
  ) {
    throw new Error('Teste de navegador exige API_PROXY_TARGET local e exclusiva.')
  }
}

const proxy = {
  '/api': {
    target: API_PROXY_TARGET || 'http://localhost:3000',
    changeOrigin: true,
  },
}

const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    headers: baseHeaders,
    ...(codespaceHost
      ? {
          allowedHosts: [codespaceHost],
          hmr: { host: codespaceHost, protocol: 'wss', clientPort: 443 },
        }
      : {}),
    proxy,
  },
  // CSP só aqui: o servidor de desenvolvimento precisa de scripts em linha para o HMR.
  preview: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    ...(codespaceHost ? { allowedHosts: [codespaceHost] } : {}),
    proxy,
    headers: {
      ...baseHeaders,
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
      ].join('; '),
    },
  },
})
