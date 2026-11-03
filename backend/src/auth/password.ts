import argon2 from 'argon2'
import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const argon2idHashPattern =
  /^\$argon2id\$v=\d+\$[^$]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/

// Formato gravado pela versão anterior do sistema no banco real:
// scrypt$N$r$p$saltHex$chaveHex. Aceito apenas na verificação; senhas novas usam Argon2id.
const scryptHashPattern =
  /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]{32})\$([0-9a-f]{128})$/
const scryptMaxMemory = 64 * 1024 * 1024

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A senha deve ser uma string não vazia.')
  }

  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })
}

function verifyScryptPassword(
  password: string,
  match: RegExpExecArray,
): Promise<boolean> {
  const [, cost, blockSize, parallelization, saltHex, keyHex] = match
  const expected = Buffer.from(keyHex, 'hex')

  return new Promise((resolve) => {
    scryptCallback(
      password,
      Buffer.from(saltHex, 'hex'),
      expected.length,
      {
        N: Number(cost),
        r: Number(blockSize),
        p: Number(parallelization),
        maxmem: scryptMaxMemory,
      },
      (error, derivedKey) => {
        resolve(!error && timingSafeEqual(derivedKey, expected))
      },
    )
  })
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    typeof encodedHash !== 'string'
  ) {
    return false
  }

  try {
    const scryptMatch = scryptHashPattern.exec(encodedHash)
    if (scryptMatch) return await verifyScryptPassword(password, scryptMatch)

    if (!argon2idHashPattern.test(encodedHash)) return false
    return await argon2.verify(encodedHash, password)
  } catch {
    return false
  }
}
