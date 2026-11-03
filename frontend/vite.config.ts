import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const port = 5173
const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN } = process.env

// No GitHub Codespaces a tela é aberta por um endereço encaminhado, que o Vite
// bloqueia por padrão. Libera somente o endereço deste Codespace.
const codespaceHost =
  CODESPACE_NAME && GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    ? `${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`
    : undefined

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port,
    strictPort: true,
    ...(codespaceHost
      ? {
          allowedHosts: [codespaceHost],
          hmr: { host: codespaceHost, protocol: 'wss', clientPort: 443 },
        }
      : {}),
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
