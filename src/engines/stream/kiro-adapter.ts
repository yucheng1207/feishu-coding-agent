import type { ProgressEmitter } from "./progress-events.js"

export interface KiroStreamState {
  sessionId: string
  textParts: string[]
  finalText: string
  errorMessage: string
}

export function createKiroStreamState(sessionId = ""): KiroStreamState {
  return { sessionId, textParts: [], finalText: "", errorMessage: "" }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
}

function shortPath(p: string): string {
  const parts = p.split("/")
  if (parts.length <= 3) return p
  return `.../${parts.slice(-2).join("/")}`
}

function summarizeKiroTool(update: Record<string, unknown>): string {
  const title = update.title
  if (typeof title === "string" && title.trim()) return title.trim()

  const meta = asRecord(update._meta)
  const kiro = asRecord(meta?.kiro)
  const toolName = kiro?.toolName
  if (typeof toolName === "string") return toolName

  const kind = update.kind
  const locations = update.locations
  if (Array.isArray(locations) && locations.length > 0) {
    const loc = asRecord(locations[0])
    const path = loc?.path
    if (typeof path === "string") {
      const k = typeof kind === "string" ? kind : "tool"
      return `${k} ${shortPath(path)}`
    }
  }

  return typeof kind === "string" ? kind : "tool"
}

export function parseKiroStreamLine(
  line: string,
  state: KiroStreamState,
  emit?: ProgressEmitter,
): void {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return
  }
  const obj = asRecord(data)
  if (!obj) return

  const type = obj.type

  if (type === "metadata") {
    const meta = asRecord(obj.data)
    const sid = meta?.sessionId
    if (typeof sid === "string" && sid.trim()) {
      state.sessionId = sid.trim()
      emit?.({ kind: "started", sessionId: state.sessionId })
    }
    return
  }

  if (type === "runError") {
    const errData = asRecord(obj.data)
    const msg = errData?.message
    if (typeof msg === "string") {
      state.errorMessage = msg
      emit?.({ kind: "error", message: msg })
    }
    return
  }

  if (type === "sessionUpdate") {
    const payload = asRecord(obj.data)
    const update = asRecord(payload?.update)
    if (!update) return

    const sid = payload?.sessionId
    if (typeof sid === "string" && sid.trim()) {
      state.sessionId = sid.trim()
    }

    const sessionUpdate = update.sessionUpdate

    if (sessionUpdate === "tool_call") {
      const summary = summarizeKiroTool(update)
      const meta = asRecord(update._meta)
      const kiro = asRecord(meta?.kiro)
      const name = typeof kiro?.toolName === "string" ? kiro.toolName : "tool"
      emit?.({
        kind: "tool",
        tool: { name, status: "started", summary },
      })
      return
    }

    if (sessionUpdate === "tool_call_update") {
      const status = update.status === "completed" ? "completed" : "started"
      const summary = summarizeKiroTool(update)
      const meta = asRecord(update._meta)
      const kiro = asRecord(meta?.kiro)
      const name = typeof kiro?.toolName === "string" ? kiro.toolName : "tool"
      emit?.({
        kind: "tool",
        tool: { name, status, summary },
      })
      return
    }

    if (sessionUpdate === "agent_message_chunk") {
      const content = asRecord(update.content)
      if (content?.type === "text" && typeof content.text === "string") {
        state.textParts.push(content.text)
        emit?.({ kind: "text", textDelta: content.text })
      }
    }
    return
  }

  if (type === "runFinished") {
    const finished = asRecord(obj.data)
    const sid = finished?.sessionId
    if (typeof sid === "string" && sid.trim()) {
      state.sessionId = sid.trim()
    }
    if (typeof finished?.finalText === "string" && finished.finalText.trim()) {
      state.finalText = finished.finalText.trim()
    }
    const status = finished?.status
    if (status === "error" || status === "failed") {
      const msg =
        typeof finished?.stopReason === "string"
          ? finished.stopReason
          : "Kiro run failed"
      state.errorMessage = msg
    }
  }
}

export function kiroStreamFinalText(state: KiroStreamState): string {
  if (state.finalText) return state.finalText
  const joined = state.textParts.join("").trim()
  return joined || "(无输出)"
}
