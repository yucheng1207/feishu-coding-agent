import type { EngineName } from "../config.js"

export interface PromptOptions {
  cwd: string
  sessionId?: string
  writeMode: boolean
  timeoutMs: number
}

export interface PromptResult {
  text: string
  sessionId: string
}

export interface CodingEngine {
  readonly name: EngineName
  prompt(text: string, opts: PromptOptions): Promise<PromptResult>
}
