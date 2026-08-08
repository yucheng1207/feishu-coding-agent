/** 按 key 串行执行，避免同一 cwd/会话并发互踩 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>()

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(task, task)
    this.tails.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}
