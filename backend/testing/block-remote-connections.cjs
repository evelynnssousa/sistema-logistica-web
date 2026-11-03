/**
 * Trava de rede para qualquer execução de teste. Carregada por NODE_OPTIONS, recusa
 * toda conexão TCP fora da própria máquina, antes de qualquer tráfego e seja qual
 * for a biblioteca. É independente das verificações em pool.ts e databaseSafety.ts.
 */
const net = require('node:net')

const allowedHosts = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '0.0.0.0',
])

function readTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]

  if (first !== null && typeof first === 'object') {
    return { host: first.host, port: first.port, path: first.path }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first }
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first }
}

if (!net.Socket.prototype.__slmRemoteConnectionsBlocked) {
  const originalConnect = net.Socket.prototype.connect

  net.Socket.prototype.connect = function connect(...args) {
    const { host, path } = readTarget(args)

    if (!path && host !== undefined && !allowedHosts.has(host)) {
      const error = new Error(
        'Conexão remota recusada: testes só podem acessar a própria máquina.',
      )
      error.code = 'E_REMOTE_CONNECTION_BLOCKED'
      throw error
    }

    return originalConnect.apply(this, args)
  }

  Object.defineProperty(net.Socket.prototype, '__slmRemoteConnectionsBlocked', {
    value: true,
  })
}
