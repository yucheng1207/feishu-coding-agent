import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { EngineName } from "../config.js"

export interface SessionBinding {
  engine: EngineName
  sessionId: string
  cwd: string
  writeMode: boolean
  createdAt: string
  updatedAt: string
}

interface StoreFile {
  version: 1
  bindings: Record<string, SessionBinding>
}

export class SessionStore {
  private data: StoreFile

  constructor(private readonly filePath: string) {
    this.data = this.load()
  }

  get(key: string): SessionBinding | undefined {
    return this.data.bindings[key]
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

  private load(): StoreFile {
    try {
      if (!existsSync(this.filePath)) {
        return { version: 1, bindings: {} }
      }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile
      if (!raw || raw.version !== 1 || typeof raw.bindings !== "object") {
        return { version: 1, bindings: {} }
      }
      return raw
    } catch {
      return { version: 1, bindings: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8")
  }
}
