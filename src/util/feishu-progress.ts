import {
  buildMarkdownCard,
  type CardHeaderTemplate,
  type FeishuSender,
} from "feishu-agent-bridge"
import type { EngineName } from "../config.js"
import type { ProgressEvent, ToolLogEntry } from "../engines/stream/progress-events.js"
import {
  formatElapsed,
  toolStatusIcon,
} from "../engines/stream/progress-events.js"

export interface ProgressCardOptions {
  engine: EngineName
  cwd: string
  sessionId?: string
  updateMs: number
  heartbeatMs: number
  textPreview: boolean
  textPreviewChars: number
}

const MAX_TOOL_LOG = 6
const MIN_UPDATE_GAP_MS = 1500

interface CardPatch {
  title: string
  markdown: string
  template: CardHeaderTemplate
  subtitle?: string
  showStopButton?: boolean
}

export class ProgressCardUpdater {
  private readonly startedAt = Date.now()
  private sessionId: string
  private currentTool: string | null = null
  private readonly toolLog: ToolLogEntry[] = []
  private textPreview = ""
  private lastFlushAt = 0
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private cancelled = false
  private cancelledPatch: CardPatch | null = null
  /** 串行化 updateCard，避免在途进度请求覆盖终态 */
  private patchChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly sender: FeishuSender,
    private readonly messageId: string,
    private readonly opts: ProgressCardOptions,
  ) {
    this.sessionId = opts.sessionId || ""
    this.heartbeatTimer = setInterval(() => {
      void this.flush(true)
    }, opts.heartbeatMs)
  }

  handleEvent(event: ProgressEvent): void {
    if (this.closed || this.cancelled) return

    if (event.sessionId) {
      this.sessionId = event.sessionId
    }

    switch (event.kind) {
      case "started":
        this.scheduleUpdate(true)
        break
      case "tool":
        if (event.tool) {
          this.pushTool(event.tool.status, event.tool.summary)
          this.currentTool =
            event.tool.status === "started" ? event.tool.summary : null
          this.scheduleUpdate(true)
        }
        break
      case "text":
        if (event.textDelta && this.opts.textPreview) {
          this.textPreview += event.textDelta
          if (this.textPreview.length > this.opts.textPreviewChars * 2) {
            this.textPreview = this.textPreview.slice(-this.opts.textPreviewChars * 2)
          }
          this.scheduleUpdate(false)
        }
        break
      case "error":
        break
      default:
        break
    }
  }

  async finishSuccess(text: string, sessionId: string): Promise<void> {
    this.closeTimers()
    this.closed = true
    this.cancelledPatch = null
    const label = sessionId || this.sessionId || "unknown"
    await this.patchCard({
      title: "✅ 回复完成",
      markdown: text || "（无输出）",
      template: "green",
      subtitle: `${this.opts.engine} · ${label}`,
    })
  }

  async finishError(message: string): Promise<void> {
    this.closeTimers()
    this.closed = true
    this.cancelledPatch = null
    await this.patchCard({
      title: "❌ 处理失败",
      markdown: message,
      template: "red",
      subtitle: this.opts.engine,
    })
  }

  async finishCancelled(sessionId: string): Promise<void> {
    this.cancelled = true
    this.closeTimers()
    this.closed = true
    const label = sessionId || this.sessionId || "(new)"
    this.cancelledPatch = {
      title: "🛑 已取消",
      markdown: [
        "当前任务已中断。",
        "",
        `session: \`${label}\``,
        "",
        "可直接发下一条消息继续聊（会 resume 同一会话）。",
      ].join("\n"),
      template: "orange",
      subtitle: `${this.opts.engine} · ${label}`,
    }
    await this.patchCard(this.cancelledPatch)
  }

  getSessionId(): string {
    return this.sessionId
  }

  dispose(): void {
    this.closeTimers()
    this.closed = true
  }

  private pushTool(status: "started" | "completed", summary: string): void {
    const icon = toolStatusIcon(status)
    const last = this.toolLog[this.toolLog.length - 1]
    if (last && last.summary === summary && last.icon === "⏳" && status === "completed") {
      last.icon = icon
      return
    }
    this.toolLog.push({ icon, summary })
    if (this.toolLog.length > MAX_TOOL_LOG) {
      this.toolLog.shift()
    }
  }

  private scheduleUpdate(priority: boolean): void {
    if (this.closed || this.cancelled) return
    const now = Date.now()
    if (priority && now - this.lastFlushAt >= MIN_UPDATE_GAP_MS) {
      void this.flush(false)
      return
    }
    if (this.updateTimer) return
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      void this.flush(false)
    }, this.opts.updateMs)
  }

  private async flush(_heartbeat = false): Promise<void> {
    if (this.closed || this.cancelled) return
    const now = Date.now()
    if (now - this.lastFlushAt < MIN_UPDATE_GAP_MS && !_heartbeat) return

    this.lastFlushAt = now
    const elapsed = formatElapsed(now - this.startedAt)
    const sessionLabel = this.sessionId || "(new)"

    const lines: string[] = [
      `⏳ **[${this.opts.engine}]** 运行中 · ${elapsed}`,
      `cwd: \`${this.opts.cwd}\``,
      `session: \`${sessionLabel}\``,
    ]

    if (this.currentTool) {
      lines.push("", "**当前**", `🔧 ${this.currentTool}`)
    }

    if (this.toolLog.length > 0) {
      lines.push("", "**最近工具**")
      for (const t of this.toolLog) {
        lines.push(`- ${t.icon} ${t.summary}`)
      }
    }

    if (this.opts.textPreview && this.textPreview.trim()) {
      const preview = this.textPreview.trim().slice(-this.opts.textPreviewChars)
      lines.push("", "**输出预览**", preview)
    }

    if (this.closed || this.cancelled) return

    await this.patchCard({
      title: "⏳ 处理中",
      markdown: lines.join("\n"),
      template: "yellow",
      subtitle: `${this.opts.engine} · ${elapsed}`,
      showStopButton: true,
    })
  }

  private isProgressPatch(template: CardHeaderTemplate): boolean {
    return template === "yellow"
  }

  private async patchCard(opts: CardPatch): Promise<void> {
    const job = async (): Promise<void> => {
      const isProgress = this.isProgressPatch(opts.template)
      if (isProgress && (this.closed || this.cancelled)) {
        return
      }

      const card = buildMarkdownCard({
        title: opts.title,
        markdown: opts.markdown,
        template: opts.template,
        subtitle: opts.subtitle,
        showStopButton: opts.showStopButton,
      })

      // 可能在 build 与发送之间被停止
      if (isProgress && (this.closed || this.cancelled)) {
        return
      }

      await this.sender.updateCard(this.messageId, card)

      // 在途黄色进度请求若晚于「已取消」完成，立即再刷终态
      if (isProgress && this.cancelled && this.cancelledPatch) {
        const terminal = buildMarkdownCard({
          title: this.cancelledPatch.title,
          markdown: this.cancelledPatch.markdown,
          template: this.cancelledPatch.template,
          subtitle: this.cancelledPatch.subtitle,
          showStopButton: this.cancelledPatch.showStopButton,
        })
        await this.sender.updateCard(this.messageId, terminal)
      }
    }

    this.patchChain = this.patchChain.then(job, job)
    await this.patchChain
  }

  private closeTimers(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer)
      this.updateTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
