import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import type { AppConfig } from "../config.js"
import { AgentCancelledError } from "./agent-cancelled.js"
import type { CodingEngine, PromptOptions, PromptResult } from "./types.js"
import {
  createCursorStreamState,
  cursorStreamFinalText,
  parseCursorStreamLine,
} from "./stream/cursor-adapter.js"
import { spawnCollectStdout, spawnNdjsonLines } from "./stream/spawn-lines.js"

const execFileAsync = promisify(execFile)

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cursorEnv(cfg: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (cfg.cursorApiKey) {
    env.CURSOR_API_KEY = cfg.cursorApiKey
  }
  const https = env.HTTPS_PROXY || ""
  if (!env.ALL_PROXY && https) env.ALL_PROXY = https
  const all = env.ALL_PROXY || https || env.HTTP_PROXY || ""
  if (!env.all_proxy && all) env.all_proxy = all
  return env
}

/**
 * `agent create-chat` 会打印 session id，但进程可能不退出（CLI bug）。
 * 因此用 spawn：读到合法 id 后主动结束子进程，避免等满 timeout 被当成失败。
 */
async function createChatId(cfg: AppConfig, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.cursorBin, ["create-chat"], {
      cwd,
      env: cursorEnv(cfg),
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timeoutMs = 60_000

    const finish = (err?: Error, id?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!child.killed) {
        child.kill("SIGTERM")
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL")
        }, 1000).unref()
      }
      if (err) reject(err)
      else resolve(id!)
    }

    const tryResolveFromStdout = () => {
      const token = stdout.trim().split(/\s+/).pop() || ""
      if (SESSION_ID_RE.test(token)) {
        finish(undefined, token)
      }
    }

    const timer = setTimeout(() => {
      finish(new Error(`agent create-chat 超时（${timeoutMs / 1000}s）且未返回 session id`))
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk)
      tryResolveFromStdout()
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk)
    })

    child.on("error", (err) => {
      if (err.message.includes("ENOENT") || (err as NodeJS.ErrnoException).code === "ENOENT") {
        finish(
          new Error(
            `找不到 Cursor CLI「${cfg.cursorBin}」。请先安装: curl https://cursor.com/install -fsS | bash\n` +
              `安装后确认 which agent，或在 .env 设置 CURSOR_BIN=/完整路径/agent`,
          ),
        )
        return
      }
      finish(err)
    })

    child.on("close", (code) => {
      if (settled) return
      const token = stdout.trim().split(/\s+/).pop() || ""
      if (SESSION_ID_RE.test(token)) {
        finish(undefined, token)
        return
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n")
      finish(
        new Error(
          `agent create-chat 失败（exit ${code ?? "null"}）${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        ),
      )
    })
  })
}

function extractSessionIdFromJson(stdout: string): string | undefined {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>
    for (const key of ["chatId", "chat_id", "sessionId", "session_id", "id"]) {
      const v = data[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
  } catch {
    // ignore
  }
  return undefined
}

function buildCursorArgs(cfg: AppConfig, sessionId: string, opts: PromptOptions, text: string): string[] {
  const stream = Boolean(opts.onProgress)
  const args = [
    "-p",
    "--trust",
    "--resume",
    sessionId,
    "--output-format",
    stream ? "stream-json" : "text",
  ]
  if (cfg.cursorModel) {
    args.push("--model", cfg.cursorModel)
  }
  if (opts.writeMode) {
    args.push("--force")
  }
  args.push(text)
  return args
}

async function promptWithStream(
  cfg: AppConfig,
  sessionId: string,
  opts: PromptOptions,
  text: string,
): Promise<PromptResult> {
  const state = createCursorStreamState(sessionId)
  const emit = opts.onProgress
  emit?.({ kind: "started", sessionId })

  const args = buildCursorArgs(cfg, sessionId, opts, text)
  let stderrBuf = ""

  const result = await spawnNdjsonLines({
    bin: cfg.cursorBin,
    args,
    cwd: opts.cwd,
    env: cursorEnv(cfg),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onLine: (line) => parseCursorStreamLine(line, state, emit),
    onStderr: (chunk) => {
      stderrBuf += chunk
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000)
    },
  })

  if (stderrBuf.trim()) {
    console.warn("[cursor] stderr:", stderrBuf.slice(0, 300))
  }

  const nextId = state.sessionId || sessionId

  if (result.cancelled) {
    throw new AgentCancelledError(nextId)
  }

  if (result.timedOut) {
    throw new Error(`Cursor 执行超时（${opts.timeoutMs / 1000}s）`)
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(`Cursor 执行失败（exit ${result.exitCode}）${stderrBuf ? `: ${stderrBuf.slice(0, 400)}` : ""}`)
  }

  return {
    text: cursorStreamFinalText(state),
    sessionId: nextId,
  }
}

async function promptWithText(
  cfg: AppConfig,
  sessionId: string,
  opts: PromptOptions,
  text: string,
): Promise<PromptResult> {
  const args = buildCursorArgs(cfg, sessionId, opts, text)

  if (opts.signal) {
    let stderrBuf = ""
    const result = await spawnCollectStdout({
      bin: cfg.cursorBin,
      args,
      cwd: opts.cwd,
      env: cursorEnv(cfg),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStderr: (chunk) => {
        stderrBuf += chunk
      },
    })
    if (stderrBuf.trim()) {
      console.warn("[cursor] stderr:", stderrBuf.slice(0, 300))
    }
    if (result.cancelled) {
      throw new AgentCancelledError(sessionId)
    }
    if (result.timedOut) {
      throw new Error(`Cursor 执行超时（${opts.timeoutMs / 1000}s）`)
    }
    if (result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error(`Cursor 执行失败（exit ${result.exitCode}）`)
    }
    const out = result.stdout.trim()
    const maybe = extractSessionIdFromJson(out)
    return { text: out || "(无输出)", sessionId: maybe || sessionId }
  }

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
}

function rethrowCursorError(err: unknown, cfg: AppConfig, timeoutMs: number): never {
  if (err instanceof AgentCancelledError) {
    throw err
  }
  const e = err as {
    killed?: boolean
    code?: string
    message?: string
    stdout?: string
    stderr?: string
  }
  if (e.message?.startsWith("agent create-chat") || e.message?.startsWith("找不到 Cursor CLI")) {
    throw err instanceof Error ? err : new Error(String(err))
  }
  if (e.killed || e.message?.includes("执行超时")) {
    throw new Error(`Cursor 执行超时（${timeoutMs / 1000}s）`)
  }
  if (e.code === "ENOENT" || /ENOENT/i.test(e.message || "")) {
    throw new Error(
      `找不到 Cursor CLI「${cfg.cursorBin}」。请先安装: curl https://cursor.com/install -fsS | bash\n` +
        `安装后确认 which agent，或在 .env 设置 CURSOR_BIN=/完整路径/agent`,
    )
  }
  const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n")
  throw new Error(`Cursor 执行失败: ${detail.slice(0, 800)}`)
}

/**
 * Cursor：默认 Agent 模式（与 IDE Agent 一致），不使用 --mode ask。
 * writeMode 时加 --force，否则只提出修改不落盘。
 */
export function createCursorEngine(cfg: AppConfig): CodingEngine {
  return {
    name: "cursor",
    async prompt(text, opts: PromptOptions): Promise<PromptResult> {
      try {
        let sessionId = (opts.sessionId || "").trim()
        if (!sessionId) {
          sessionId = await createChatId(cfg, opts.cwd)
        }

        if (opts.onProgress) {
          return await promptWithStream(cfg, sessionId, opts, text)
        }
        return await promptWithText(cfg, sessionId, opts, text)
      } catch (err: unknown) {
        rethrowCursorError(err, cfg, opts.timeoutMs)
      }
    },
  }
}
