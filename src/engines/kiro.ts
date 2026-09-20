import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AppConfig } from "../config.js"
import { AgentCancelledError } from "./agent-cancelled.js"
import type { CodingEngine, PromptOptions, PromptResult } from "./types.js"
import {
  createKiroStreamState,
  kiroStreamFinalText,
  parseKiroStreamLine,
} from "./stream/kiro-adapter.js"
import { spawnCollectStdout, spawnNdjsonLines } from "./stream/spawn-lines.js"

const execFileAsync = promisify(execFile)

function kiroEnv(cfg: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (cfg.kiroApiKey) {
    env.KIRO_API_KEY = cfg.kiroApiKey
  }
  return env
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

function buildKiroArgs(cfg: AppConfig, opts: PromptOptions, text: string): string[] {
  const stream = Boolean(opts.onProgress)
  const args = ["chat", "--no-interactive"]
  if (stream) {
    args.push("--agent-engine", cfg.kiroAgentEngine)
    args.push("--output-format", "stream-json")
  }

  const sessionId = (opts.sessionId || "").trim()
  if (sessionId) {
    args.push("--resume-id", sessionId)
  }
  if (cfg.kiroModel) {
    args.push("--model", cfg.kiroModel)
  }
  if (cfg.kiroEffort) {
    args.push("--effort", cfg.kiroEffort)
  }

  if (opts.writeMode) {
    args.push("--trust-all-tools")
  } else if (cfg.kiroTrustTools) {
    const readish = cfg.kiroTrustTools
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/write|bash|shell|execute/i.test(s))
      .join(",")
    args.push(`--trust-tools=${readish || "fs_read,grep"}`)
  }

  args.push(text)
  return args
}

async function promptWithStream(
  cfg: AppConfig,
  opts: PromptOptions,
  text: string,
): Promise<PromptResult> {
  const sessionId = (opts.sessionId || "").trim()
  const state = createKiroStreamState(sessionId)
  const emit = opts.onProgress
  emit?.({ kind: "started", sessionId: sessionId || undefined })

  let stderrBuf = ""
  const args = buildKiroArgs(cfg, opts, text)

  const result = await spawnNdjsonLines({
    bin: cfg.kiroBin,
    args,
    cwd: opts.cwd,
    env: kiroEnv(cfg),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onLine: (line) => parseKiroStreamLine(line, state, emit),
    onStderr: (chunk) => {
      stderrBuf += chunk
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000)
    },
  })

  if (stderrBuf.trim()) {
    console.warn("[kiro] stderr:", stderrBuf.slice(0, 300))
  }

  let nextId = state.sessionId || sessionId

  if (result.cancelled) {
    if (!nextId) {
      nextId = (await listNewestSessionId(cfg, opts.cwd)) || ""
    }
    throw new AgentCancelledError(nextId)
  }

  if (state.errorMessage) {
    throw new Error(`Kiro 执行失败: ${state.errorMessage}`)
  }

  if (result.timedOut) {
    throw new Error(`Kiro 执行超时（${opts.timeoutMs / 1000}s）`)
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(`Kiro 执行失败（exit ${result.exitCode}）${stderrBuf ? `: ${stderrBuf.slice(0, 400)}` : ""}`)
  }

  if (!nextId) {
    nextId = (await listNewestSessionId(cfg, opts.cwd)) || ""
  }

  return {
    text: kiroStreamFinalText(state),
    sessionId: nextId,
  }
}

async function promptWithText(
  cfg: AppConfig,
  opts: PromptOptions,
  text: string,
): Promise<PromptResult> {
  const sessionId = (opts.sessionId || "").trim()
  const args = buildKiroArgs(cfg, opts, text)

  if (opts.signal) {
    let stderrBuf = ""
    const result = await spawnCollectStdout({
      bin: cfg.kiroBin,
      args,
      cwd: opts.cwd,
      env: kiroEnv(cfg),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStderr: (chunk) => {
        stderrBuf += chunk
      },
    })
    if (stderrBuf.trim()) {
      console.warn("[kiro] stderr:", stderrBuf.slice(0, 300))
    }
    if (result.cancelled) {
      let nextId = sessionId
      if (!nextId) {
        nextId = (await listNewestSessionId(cfg, opts.cwd)) || ""
      }
      throw new AgentCancelledError(nextId)
    }
    if (result.timedOut) {
      throw new Error(`Kiro 执行超时（${opts.timeoutMs / 1000}s）`)
    }
    if (result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error(`Kiro 执行失败（exit ${result.exitCode}）`)
    }
    let nextId = sessionId
    if (!nextId) {
      nextId = (await listNewestSessionId(cfg, opts.cwd)) || ""
    }
    return {
      text: result.stdout.trim() || "(无输出)",
      sessionId: nextId,
    }
  }

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
}

function rethrowKiroError(err: unknown, timeoutMs: number): never {
  if (err instanceof AgentCancelledError) {
    throw err
  }
  const e = err as {
    killed?: boolean
    message?: string
    stdout?: string
    stderr?: string
  }
  if (e.killed || e.message?.includes("执行超时")) {
    throw new Error(`Kiro 执行超时（${timeoutMs / 1000}s）`)
  }
  const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n")
  throw new Error(`Kiro 执行失败: ${detail.slice(0, 800)}`)
}

export function createKiroEngine(cfg: AppConfig): CodingEngine {
  return {
    name: "kiro",
    async prompt(text, opts: PromptOptions): Promise<PromptResult> {
      try {
        if (opts.onProgress) {
          return await promptWithStream(cfg, opts, text)
        }
        return await promptWithText(cfg, opts, text)
      } catch (err: unknown) {
        rethrowKiroError(err, opts.timeoutMs)
      }
    },
  }
}
