export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export type RateLimiterOptions = {
  limit: number
  windowMs: number
  maxEntries?: number
  now?: () => number
}

type Entry = { count: number; resetAt: number }

/**
 * Limitador em memória, com janela fixa. Vale para uma única instância da API:
 * com mais de uma instância, cada uma contaria separadamente.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.maxEntries = options.maxEntries ?? 10_000
    this.now = options.now ?? Date.now
  }

  /** Consulta o limite sem contar uma nova tentativa. */
  check(key: string): RateLimitResult {
    return this.resultFor(this.currentEntry(key)?.count ?? 0, key)
  }

  /** Conta uma tentativa. Bloqueia quando o limite já tinha sido atingido. */
  consume(key: string): RateLimitResult {
    const entry = this.currentEntry(key)

    if (!entry) {
      this.makeRoom()
      this.entries.set(key, { count: 1, resetAt: this.now() + this.windowMs })
      return {
        allowed: true,
        remaining: this.limit - 1,
        retryAfterSeconds: this.secondsUntilReset(key),
      }
    }

    if (entry.count >= this.limit) return this.resultFor(entry.count, key)

    entry.count += 1
    return {
      allowed: true,
      remaining: this.limit - entry.count,
      retryAfterSeconds: this.secondsUntilReset(key),
    }
  }

  /** Devolve uma tentativa reservada que não chegou a ser avaliada. */
  release(key: string) {
    const entry = this.currentEntry(key)
    if (entry && entry.count > 0) entry.count -= 1
  }

  reset(key: string) {
    this.entries.delete(key)
  }

  get size() {
    return this.entries.size
  }

  private currentEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key)
    if (entry && entry.resetAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private resultFor(count: number, key: string): RateLimitResult {
    return {
      allowed: count < this.limit,
      remaining: Math.max(0, this.limit - count),
      retryAfterSeconds: this.secondsUntilReset(key),
    }
  }

  private secondsUntilReset(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return 0
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000))
  }

  // A memória fica limitada mesmo que um atacante varie as chaves.
  private makeRoom() {
    if (this.entries.size < this.maxEntries) return

    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key)
    }

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}
