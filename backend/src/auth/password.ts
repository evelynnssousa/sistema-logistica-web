import argon2 from 'argon2'

const argon2idHashPattern =
  /^\$argon2id\$v=\d+\$[^$]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/

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

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    typeof encodedHash !== 'string' ||
    !argon2idHashPattern.test(encodedHash)
  ) {
    return false
  }

  try {
    return await argon2.verify(encodedHash, password)
  } catch {
    return false
  }
}