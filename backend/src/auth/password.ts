import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

const COST = 32_768
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const KEY_LENGTH = 64
const MAX_MEMORY = 64 * 1024 * 1024

function deriveKey(password: string, salt: Buffer, keyLength: number, cost: number,
  blockSize: number, parallelization: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key as Buffer)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = await deriveKey(
    password,
    salt,
    KEY_LENGTH,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
  )

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('hex'),
    derivedKey.toString('hex'),
  ].join('$')
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelization, saltHex, keyHex] = storedHash.split('$')
  if (algorithm !== 'scrypt' || !cost || !blockSize || !parallelization || !saltHex || !keyHex) {
    return false
  }

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false

  const actual = await deriveKey(
    password,
    salt,
    expected.length,
    Number(cost),
    Number(blockSize),
    Number(parallelization),
  )

  return timingSafeEqual(actual, expected)
}