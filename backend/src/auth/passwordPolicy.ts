/**
 * Tamanho da senha (14/11/2026): mínimo de 8 caracteres, como recomenda o NIST (SP 800-63B).
 * A proteção vem do hash lento, do limite de tentativas e do bloqueio, não do tamanho exagerado.
 * O mesmo número está em frontend/src/auth/passwordPolicy.ts.
 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 512
