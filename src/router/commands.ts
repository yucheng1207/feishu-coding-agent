import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { AppConfig, EngineName } from "../config.js"
import type { SessionBinding, SessionStore } from "../session/store.js"

export type CommandResult =
  | { kind: "reply"; text: string }
  | { kind: "prompt"; text: string }
  | { kind: "noop" }

function helpText(): string {
  return [
    "feishu-coding-agent 命令：",
    "/cursor — 使用 Cursor（同话题换引擎会新开会话）",
    "/kiro — 使用 Kiro（同话题换引擎会新开会话）",
    "/cwd <path> — 设置工作目录",
    "/new — 当前引擎新开会话",
    "/write on|off — 是否允许改文件（默认 off）",
    "/resume <sessionId> — 挂到已有引擎会话",
    "/status — 查看当前绑定",
    "/help — 帮助",
    "",
    "普通消息：在当前绑定上 resume 续聊。",
  ].join("\n")
}

function formatStatus(key: string, b: SessionBinding | undefined, cfg: AppConfig): string {
  if (!b) {
    return [
      `sessionKey: ${key}`,
      `engine: ${cfg.defaultEngine}（尚未绑定，首条消息时创建）`,
      `cwd: ${cfg.defaultCwd}`,
      `writeMode: ${cfg.defaultWriteMode}`,
      `sessionId: （空）`,
    ].join("\n")
  }
  return [
    `sessionKey: ${key}`,
    `engine: ${b.engine}`,
    `cwd: ${b.cwd}`,
    `writeMode: ${b.writeMode}`,
    `sessionId: ${b.sessionId || "（空，下一条将新建）"}`,
    `updatedAt: ${b.updatedAt}`,
  ].join("\n")
}

function ensureBinding(
  store: SessionStore,
  key: string,
  cfg: AppConfig,
): SessionBinding {
  const existing = store.get(key)
  if (existing) return existing
  const now = new Date().toISOString()
  const created: SessionBinding = {
    engine: cfg.defaultEngine,
    sessionId: "",
    cwd: cfg.defaultCwd,
    writeMode: cfg.defaultWriteMode,
    createdAt: now,
    updatedAt: now,
  }
  store.set(key, created)
  return created
}

function switchEngine(
  store: SessionStore,
  key: string,
  cfg: AppConfig,
  engine: EngineName,
): string {
  const prev = ensureBinding(store, key, cfg)
  if (prev.engine === engine && prev.sessionId) {
    return `已在使用 ${engine}（session=${prev.sessionId}）\n${formatStatus(key, prev, cfg)}`
  }
  const next = store.update(key, {
    engine,
    sessionId: "",
    cwd: prev.cwd,
    writeMode: prev.writeMode,
  })
  const note =
    prev.engine !== engine && prev.sessionId
      ? `\n注意：已从 ${prev.engine} 切换到 ${engine}，上下文不会自动迁移；已新开会话。`
      : `\n已切换到 ${engine}，下一条消息将创建新会话。`
  return `${note}\n${formatStatus(key, next, cfg)}`
}

/** 解析斜杠命令；非命令则返回 prompt */
export function dispatchCommand(
  raw: string,
  sessionKey: string,
  store: SessionStore,
  cfg: AppConfig,
): CommandResult {
  const text = raw.trim()
  if (!text) return { kind: "noop" }

  if (!text.startsWith("/")) {
    return { kind: "prompt", text }
  }

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(" ").trim()
  const name = cmd.toLowerCase()

  switch (name) {
    case "/help":
    case "/h":
      return { kind: "reply", text: helpText() }

    case "/status":
      return {
        kind: "reply",
        text: formatStatus(sessionKey, store.get(sessionKey), cfg),
      }

    case "/cursor":
      return { kind: "reply", text: switchEngine(store, sessionKey, cfg, "cursor") }

    case "/kiro":
      return { kind: "reply", text: switchEngine(store, sessionKey, cfg, "kiro") }

    case "/new": {
      const b = ensureBinding(store, sessionKey, cfg)
      const next = store.update(sessionKey, { sessionId: "" })
      return {
        kind: "reply",
        text: `已清空 session，下一条消息将用 ${b.engine} 新开会话。\n${formatStatus(sessionKey, next, cfg)}`,
      }
    }

    case "/write": {
      ensureBinding(store, sessionKey, cfg)
      const on = ["on", "1", "true", "yes"].includes(arg.toLowerCase())
      const off = ["off", "0", "false", "no"].includes(arg.toLowerCase())
      if (!on && !off) {
        return { kind: "reply", text: "用法: /write on 或 /write off" }
      }
      const next = store.update(sessionKey, { writeMode: on })
      return {
        kind: "reply",
        text: `writeMode = ${next.writeMode}\n${formatStatus(sessionKey, next, cfg)}`,
      }
    }

    case "/cwd": {
      if (!arg) return { kind: "reply", text: "用法: /cwd <绝对或相对路径>" }
      const cwd = resolve(arg.replace(/^~(?=\/|$)/, process.env.HOME || ""))
      if (!existsSync(cwd)) {
        return { kind: "reply", text: `目录不存在: ${cwd}` }
      }
      ensureBinding(store, sessionKey, cfg)
      const next = store.update(sessionKey, { cwd, sessionId: "" })
      return {
        kind: "reply",
        text: `已设置 cwd，并清空 session（建议换目录后新开）。\n${formatStatus(sessionKey, next, cfg)}`,
      }
    }

    case "/resume": {
      if (!arg) return { kind: "reply", text: "用法: /resume <sessionId>" }
      ensureBinding(store, sessionKey, cfg)
      const next = store.update(sessionKey, { sessionId: arg })
      return {
        kind: "reply",
        text: `已绑定 sessionId。\n${formatStatus(sessionKey, next, cfg)}`,
      }
    }

    default:
      return {
        kind: "reply",
        text: `未知命令 ${cmd}\n\n${helpText()}`,
      }
  }
}
