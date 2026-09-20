export type ProgressEventKind = "started" | "tool" | "text" | "finished" | "error"

export interface ToolProgress {
  name: string
  status: "started" | "completed"
  summary: string
}

export interface ProgressEvent {
  kind: ProgressEventKind
  sessionId?: string
  tool?: ToolProgress
  textDelta?: string
  finalText?: string
  message?: string
}

export type ProgressEmitter = (event: ProgressEvent) => void

export interface ToolLogEntry {
  icon: string
  summary: string
}

export function toolStatusIcon(status: ToolProgress["status"]): string {
  return status === "completed" ? "✅" : "⏳"
}

export function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return rem > 0 ? `${min}m ${rem}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const m = min % 60
  return m > 0 ? `${hr}h ${m}m` : `${hr}h`
}
