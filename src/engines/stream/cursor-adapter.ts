import type { ProgressEmitter } from "./progress-events.js"

export interface CursorStreamState {
  sessionId: string
  textParts: string[]
  finalText: string
}

export function createCursorStreamState(sessionId = ""): CursorStreamState {
  return { sessionId, textParts: [], finalText: "" }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
}

function summarizeCursorTool(toolKey: string, payload: unknown): string {
  const p = asRecord(payload)
  const args = asRecord(p?.args) || p || {}

  switch (toolKey) {
    case "readToolCall": {
      const path = args.path
      return typeof path === "string" ? `Read ${shortPath(path)}` : "Read file"
    }
    case "writeToolCall":
    case "editToolCall": {
      const path = args.path
      return typeof path === "string" ? `Write ${shortPath(path)}` : "Write file"
    }
    case "deleteToolCall": {
      const path = args.path
      return typeof path === "string" ? `Delete ${shortPath(path)}` : "Delete file"
    }
    case "grepToolCall": {
      const pattern = args.pattern ?? args.query
      const path = args.path ?? args.glob
      const p = typeof pattern === "string" ? `"${truncate(pattern, 40)}"` : "pattern"
      const loc = typeof path === "string" ? ` in ${shortPath(path)}` : ""
      return `Grep ${p}${loc}`
    }
    case "globToolCall": {
      const pattern = args.globPattern ?? args.pattern
      return typeof pattern === "string" ? `Glob ${pattern}` : "Glob files"
    }
    case "lsToolCall": {
      const path = args.path
      return typeof path === "string" ? `List ${shortPath(path)}` : "List directory"
    }
    case "shellToolCall":
    case "bashToolCall": {
      const cmd = args.command ?? args.cmd
      return typeof cmd === "string" ? `Shell ${truncate(cmd, 60)}` : "Shell command"
    }
    case "todoToolCall":
      return "Update todos"
    default:
      return toolKey.replace(/ToolCall$/, "") || "tool"
  }
}

function shortPath(p: string): string {
  const parts = p.split("/")
  if (parts.length <= 3) return p
  return `.../${parts.slice(-2).join("/")}`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`
}

export function parseCursorStreamLine(
  line: string,
  state: CursorStreamState,
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
  if (type === "system" && obj.subtype === "init") {
    const sid = obj.session_id
    if (typeof sid === "string" && sid.trim()) {
      state.sessionId = sid.trim()
      emit?.({ kind: "started", sessionId: state.sessionId })
    }
    return
  }

  if (type === "tool_call") {
    const toolCall = asRecord(obj.tool_call)
    if (!toolCall) return
    const name = Object.keys(toolCall)[0] || "tool"
    const subtype = obj.subtype === "completed" ? "completed" : "started"
    const summary = summarizeCursorTool(name, toolCall[name])
    emit?.({
      kind: "tool",
      tool: { name, status: subtype, summary },
    })
    return
  }

  if (type === "assistant") {
    const msg = asRecord(obj.message)
    const content = msg?.content
    if (!Array.isArray(content)) return
    const texts = content
      .map((c) => asRecord(c))
      .filter((c) => c?.type === "text")
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("")
    if (texts) {
      state.textParts.push(texts)
      emit?.({ kind: "text", textDelta: texts })
    }
    return
  }

  if (type === "result") {
    const sid = obj.session_id
    if (typeof sid === "string" && sid.trim()) {
      state.sessionId = sid.trim()
    }
    if (typeof obj.result === "string" && obj.result.trim()) {
      state.finalText = obj.result.trim()
    }
  }
}

export function cursorStreamFinalText(state: CursorStreamState): string {
  if (state.finalText) return state.finalText
  const joined = state.textParts.join("").trim()
  return joined || "(无输出)"
}
