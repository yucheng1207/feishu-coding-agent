import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { EngineName } from "../config.js"

export interface SessionBinding {
  engine: EngineName
  sessionId: string
  cwd: string
  writeMode: boolean
  /**
   * 群话题：为 true 时仅 @ 本机器人才处理（关闭「已绑定可无 @ 续聊」）
   * 缺省 / false = 沿用默认逻辑
   */
  requireAt?: boolean
  createdAt: string
  updatedAt: string
}

interface StoreFile {
  version: 2
  bindings: Record<string, SessionBinding>
  /**
   * 飞书消息 ID → sessionKey
   * 用于：用户回复机器人消息时 root/parent 漂到 bot 消息上，仍能回到原话题 binding
   */
  messageAliases: Record<string, string>
}

export class SessionStore {
  private data: StoreFile

  constructor(private readonly filePath: string) {
    this.data = this.load()
  }

  get(key: string): SessionBinding | undefined {
    return this.data.bindings[key]
  }

  has(key: string): boolean {
    return !!this.data.bindings[key]
  }

  set(key: string, binding: SessionBinding): void {
    this.data.bindings[key] = binding
    this.save()
  }

  update(
    key: string,
    patch: Partial<Omit<SessionBinding, "createdAt">>,
  ): SessionBinding {
    const prev = this.data.bindings[key]
    const now = new Date().toISOString()
    const next: SessionBinding = {
      engine: patch.engine ?? prev?.engine ?? "cursor",
      sessionId: patch.sessionId ?? prev?.sessionId ?? "",
      cwd: patch.cwd ?? prev?.cwd ?? process.cwd(),
      writeMode: patch.writeMode ?? prev?.writeMode ?? false,
      requireAt: patch.requireAt ?? prev?.requireAt ?? false,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    }
    this.data.bindings[key] = next
    this.save()
    return next
  }

  clearSessionId(key: string): SessionBinding | undefined {
    const prev = this.data.bindings[key]
    if (!prev) return undefined
    return this.update(key, { sessionId: "" })
  }

  /** 将飞书消息 ID 映射到 sessionKey（覆盖写入） */
  aliasMessage(messageId: string, sessionKey: string): void {
    const id = messageId.trim()
    if (!id || !sessionKey) return
    this.data.messageAliases[id] = sessionKey
    this.save()
  }

  resolveAlias(messageId: string | undefined): string | undefined {
    if (!messageId) return undefined
    return this.data.messageAliases[messageId.trim()]
  }

  private load(): StoreFile {
    try {
      if (!existsSync(this.filePath)) {
        return { version: 2, bindings: {}, messageAliases: {} }
      }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        version?: number
        bindings?: Record<string, SessionBinding>
        messageAliases?: Record<string, string>
      }
      if (!raw || typeof raw.bindings !== "object") {
        return { version: 2, bindings: {}, messageAliases: {} }
      }
      return {
        version: 2,
        bindings: raw.bindings,
        messageAliases:
          raw.messageAliases && typeof raw.messageAliases === "object"
            ? raw.messageAliases
            : {},
      }
    } catch {
      return { version: 2, bindings: {}, messageAliases: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8")
  }
}
