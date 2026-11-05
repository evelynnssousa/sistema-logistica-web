import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Cifra o CPF antes de chegar ao banco (AES-256-GCM), com a chave fora dele: quem obtiver
 * só uma cópia do banco, como um backup, não obtém os números. Sem chave, nada é gravado.
 */

const version = 'v1'

export class CpfProtectionUnavailableError extends Error {
  constructor() {
    super('A proteção de dados dos passageiros não está configurada.')
    this.name = 'CpfProtectionUnavailableError'
  }
}

function readKey(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.PASSENGER_DATA_KEY?.trim()
  const key = encoded ? Buffer.from(encoded, 'base64') : null
  if (!key || key.length !== 32) throw new CpfProtectionUnavailableError()
  return key
}

export function isValidCpf(value: string) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false

  const digit = (length: number) => {
    let sum = 0
    for (let index = 0; index < length; index += 1) {
      sum += Number(value[index]) * (length + 1 - index)
    }
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  return digit(9) === Number(value[9]) && digit(10) === Number(value[10])
}

export function encryptCpf(
  cpf: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', readKey(environment), iv)
  const encrypted = Buffer.concat([cipher.update(cpf, 'utf8'), cipher.final()])
  return [
    version,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.')
}

export function decryptCpf(
  stored: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const [storedVersion, iv, tag, encrypted] = stored.split('.')
  if (storedVersion !== version || !iv || !tag || !encrypted) {
    throw new Error('CPF cifrado em formato desconhecido.')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    readKey(environment),
    Buffer.from(iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
