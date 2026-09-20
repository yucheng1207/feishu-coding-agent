import type { EngineName } from "../config.js"
import type { ProgressEmitter } from "./stream/progress-events.js"

export type { ProgressEmitter, ProgressEvent } from "./stream/progress-events.js"

export interface PromptOptions {
  cwd: string
  sessionId?: string
  writeMode: boolean
  timeoutMs: number
  /** 提供时走 stream-json 并推送进度事件 */
  onProgress?: ProgressEmitter
  /** /stop 触发 abort，中断 CLI 子进程 */
  signal?: AbortSignal
}

export interface PromptResult {
  text: string
  sessionId: string
}

export interface CodingEngine {
  readonly name: EngineName
  prompt(text: string, opts: PromptOptions): Promise<PromptResult>
}
