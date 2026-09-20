/** 按 sessionKey 跟踪运行中的 Agent，供 /stop 与卡片按钮中断 */
export interface ActiveRun {
  controller: AbortController
  progressMessageId?: string
  stopUi?: () => Promise<void>
}

export class RunRegistry {
  private readonly active = new Map<string, ActiveRun>()
  private readonly messageIndex = new Map<string, string>()

  register(sessionKey: string): AbortController {
    const controller = new AbortController()
    this.active.set(sessionKey, { controller })
    return controller
  }

  bindProgress(
    sessionKey: string,
    progressMessageId: string,
    stopUi: () => Promise<void>,
  ): void {
    const run = this.active.get(sessionKey)
    if (!run) return
    run.progressMessageId = progressMessageId
    run.stopUi = stopUi
    this.messageIndex.set(progressMessageId, sessionKey)
  }

  resolveSessionKey(messageId: string): string | undefined {
    return this.messageIndex.get(messageId)
  }

  isRunning(sessionKey: string): boolean {
    return this.active.has(sessionKey)
  }

  /** 中断 CLI，并立即刷新进度卡片（不等待子进程完全退出） */
  async cancel(sessionKey: string): Promise<boolean> {
    const run = this.active.get(sessionKey)
    if (!run) return false
    // 先刷 UI 终态，再 abort，避免 abort 触发的尾流事件抢写进度卡
    if (run.stopUi) {
      try {
        await run.stopUi()
      } catch (err) {
        console.warn("[run] stopUi failed:", (err as Error).message)
      }
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort()
    }
    return true
  }

  unregister(sessionKey: string): void {
    const run = this.active.get(sessionKey)
    if (run?.progressMessageId) {
      this.messageIndex.delete(run.progressMessageId)
    }
    this.active.delete(sessionKey)
  }
}
