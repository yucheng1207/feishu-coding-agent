import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AppConfig } from "../config.js"
import type { CodingEngine, PromptOptions, PromptResult } from "./types.js"

const execFileAsync = promisify(execFile)

function kiroEnv(cfg: AppConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIRO_API_KEY: cfg.kiroApiKey || process.env.KIRO_API_KEY || "",
  }
}

interface KiroSessionRow {
  id?: string
  session_id?: string
  sessionId?: string
  updated_at?: string
  updatedAt?: string
  timestamp?: string
}

async function listNewestSessionId(
  cfg: AppConfig,
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      cfg.kiroBin,
      ["chat", "--list-sessions", "-f", "json"],
      {
        cwd,
        env: kiroEnv(cfg),
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const raw = String(stdout).trim()
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as KiroSessionRow[] | { sessions?: KiroSessionRow[] }
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.sessions)
        ? parsed.sessions
        : []
    if (rows.length === 0) return undefined

    const scored = rows
      .map((r) => {
        const id = r.id || r.session_id || r.sessionId || ""
        const t = r.updated_at || r.updatedAt || r.timestamp || ""
        return { id, t }
      })
      .filter((r) => r.id)
    if (scored.length === 0) return undefined
    scored.sort((a, b) => String(b.t).localeCompare(String(a.t)))
    return scored[0]?.id
  } catch (err) {
    console.warn("[kiro] list-sessions 失败:", (err as Error).message)
    return undefined
  }
}

export function createKiroEngine(cfg: AppConfig): CodingEngine {
  return {
    name: "kiro",
    async prompt(text, opts: PromptOptions): Promise<PromptResult> {
      if (!cfg.kiroApiKey) {
        throw new Error("未配置 KIRO_API_KEY")
      }

      const args = ["chat", "--no-interactive"]
      const sessionId = (opts.sessionId || "").trim()
      if (sessionId) {
        args.push("--resume-id", sessionId)
      }

      if (opts.writeMode) {
        args.push("--trust-all-tools")
      } else if (cfg.kiroTrustTools) {
        // 只读场景尽量收紧；仍允许配置覆盖
        const readish = cfg.kiroTrustTools
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && !/write|bash|shell|execute/i.test(s))
          .join(",")
        args.push(`--trust-tools=${readish || "fs_read,grep"}`)
      }

      args.push(text)

      try {
        const { stdout, stderr } = await execFileAsync(cfg.kiroBin, args, {
          cwd: opts.cwd,
          env: kiroEnv(cfg),
          timeout: opts.timeoutMs,
          maxBuffer: 12 * 1024 * 1024,
        })
        if (stderr && String(stderr).trim()) {
          console.warn("[kiro] stderr:", String(stderr).slice(0, 300))
        }

        let nextId = sessionId
        if (!nextId) {
          nextId = (await listNewestSessionId(cfg, opts.cwd)) || ""
        }

        return {
          text: String(stdout).trim() || "(无输出)",
          sessionId: nextId,
        }
      } catch (err: unknown) {
        const e = err as {
          killed?: boolean
          message?: string
          stdout?: string
          stderr?: string
        }
        if (e.killed) {
          throw new Error(`Kiro 执行超时（${opts.timeoutMs / 1000}s）`)
        }
        const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n")
        throw new Error(`Kiro 执行失败: ${detail.slice(0, 800)}`)
      }
    },
  }
}
