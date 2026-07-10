export interface AlbumMessage { id: number; groupedId: string | null }

/**
 * Telegram доставляет альбом N отдельными апдейтами. Копим их по groupedId,
 * пока не пройдёт окно тишины, и отдаём одним пакетом: подпись лежит ровно на
 * одном элементе (иногда её нет вовсе), и AI должна увидеть все фото сразу.
 */
export class AlbumBuffer<T extends AlbumMessage> {
  private readonly pending = new Map<string, { messages: T[]; timer: NodeJS.Timeout }>()

  constructor(
    private readonly windowMs: number,
    private readonly flush: (messages: T[]) => void,
  ) {}

  push(message: T): void {
    if (!message.groupedId) {
      this.flush([message])
      return
    }
    const key = message.groupedId
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing.timer)

    const messages = existing ? [...existing.messages, message] : [message]
    const timer = setTimeout(() => this.release(key), this.windowMs)
    this.pending.set(key, { messages, timer })
  }

  /** Отдаёт всё недособранное — вызывается при остановке процесса. */
  drain(): void {
    for (const key of [...this.pending.keys()]) this.release(key)
  }

  private release(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    this.flush([...entry.messages].sort((a, b) => a.id - b.id))
  }
}
