import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AppConfig } from "../config.js"
import type { CodingEngine, PromptOptions, PromptResult } from "./types.js"

const execFileAsync = promisify(execFile)

function cursorEnv(cfg: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CURSOR_API_KEY: cfg.cursorApiKey || process.env.CURSOR_API_KEY || "",
  }
  const https = env.HTTPS_PROXY || ""
  if (!env.ALL_PROXY && https) env.ALL_PROXY = https
  const all = env.ALL_PROXY || https || env.HTTP_PROXY || ""
  if (!env.all_proxy && all) env.all_proxy = all
  return env
}

async function createChatId(cfg: AppConfig, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(cfg.cursorBin, ["create-chat"], {
    cwd,
    env: cursorEnv(cfg),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  const id = String(stdout).trim().split(/\s+/).pop() || ""
  if (!id) throw new Error("agent create-chat 未返回 session id")
  return id
}

function extractSessionIdFromJson(stdout: string): string | undefined {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    for (const key of ["chatId", "chat_id", "sessionId", "session_id", "id"]) {
      const v = data[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
  } catch {
    // not a single json object — ignore
  }
  return undefined
}

export function createCursorEngine(cfg: AppConfig): CodingEngine {
  return {
    name: "cursor",
    async prompt(text, opts: PromptOptions): Promise<PromptResult> {
      if (!cfg.cursorApiKey) {
        throw new Error("未配置 CURSOR_API_KEY")
      }

      let sessionId = (opts.sessionId || "").trim()
      if (!sessionId) {
        sessionId = await createChatId(cfg, opts.cwd)
      }

      const args = [
        "-p",
        "--trust",
        "--resume",
        sessionId,
        "--output-format",
        "text",
      ]
      if (opts.writeMode) {
        args.push("--force")
      } else {
        args.push("--mode", "ask")
      }
      args.push(text)

      try {
        const { stdout, stderr } = await execFileAsync(cfg.cursorBin, args, {
          cwd: opts.cwd,
          env: cursorEnv(cfg),
          timeout: opts.timeoutMs,
          maxBuffer: 12 * 1024 * 1024,
        })
        if (stderr && String(stderr).trim()) {
          console.warn("[cursor] stderr:", String(stderr).slice(0, 300))
        }
        const out = String(stdout).trim()
        const maybe = extractSessionIdFromJson(out)
        return { text: out || "(无输出)", sessionId: maybe || sessionId }
      } catch (err: unknown) {
        const e = err as {
          killed?: boolean
          message?: string
          stdout?: string
          stderr?: string
        }
        if (e.killed) {
          throw new Error(`Cursor 执行超时（${opts.timeoutMs / 1000}s）`)
        }
        const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n")
        throw new Error(`Cursor 执行失败: ${detail.slice(0, 800)}`)
      }
    },
  }
}
