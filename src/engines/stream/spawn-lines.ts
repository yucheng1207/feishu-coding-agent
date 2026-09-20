import { spawn, type ChildProcess } from "node:child_process"
import readline from "node:readline"

export interface SpawnNdjsonOptions {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  onLine: (line: string) => void
  onStderr?: (chunk: string) => void
}

export interface SpawnCollectOptions {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  onStderr?: (chunk: string) => void
}

export interface SpawnProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  stdout: string
}

function killChildTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
    setTimeout(() => {
      if (child.killed) return
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        if (!child.killed) child.kill("SIGKILL")
      }
    }, 500).unref()
    return
  }

  child.kill("SIGTERM")
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL")
  }, 500).unref()
}

function spawnChild(
  bin: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(bin, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Unix：子进程独立进程组，便于 kill(-pid) 杀掉 kiro 拉起的子进程
    detached: process.platform !== "win32",
  })
}

function attachAbort(
  signal: AbortSignal | undefined,
  child: ChildProcess,
  onCancel: () => void,
  clearTimer: () => void,
): void {
  if (!signal) return
  const fire = () => {
    onCancel()
    clearTimer()
    killChildTree(child)
  }
  if (signal.aborted) {
    fire()
    return
  }
  signal.addEventListener("abort", fire, { once: true })
}

/**
 * spawn 子进程，按行读取 stdout；仅回调以 `{` 开头的 NDJSON 行。
 */
export function spawnNdjsonLines(opts: SpawnNdjsonOptions): Promise<SpawnProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(opts.bin, opts.args, opts.cwd, opts.env)

    let timedOut = false
    let cancelled = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const finish = (result: SpawnProcessResult) => {
      if (settled) return
      settled = true
      clearTimer()
      rl.close()
      resolve(result)
    }

    timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, opts.timeoutMs)

    attachAbort(opts.signal, child, () => {
      cancelled = true
    }, clearTimer)

    const rl = readline.createInterface({ input: child.stdout! })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("{")) {
        opts.onLine(trimmed)
      }
    })

    child.stderr?.on("data", (chunk: Buffer | string) => {
      opts.onStderr?.(String(chunk))
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimer()
      rl.close()
      reject(err)
    })

    child.on("close", (code, signal) => {
      finish({
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        stdout: "",
      })
    })
  })
}

/** spawn 并收集全部 stdout（text 模式，支持取消） */
export function spawnCollectStdout(opts: SpawnCollectOptions): Promise<SpawnProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(opts.bin, opts.args, opts.cwd, opts.env)

    let timedOut = false
    let cancelled = false
    let settled = false
    let stdout = ""
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, opts.timeoutMs)

    attachAbort(opts.signal, child, () => {
      cancelled = true
    }, clearTimer)

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk)
    })

    child.stderr?.on("data", (chunk: Buffer | string) => {
      opts.onStderr?.(String(chunk))
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimer()
      reject(err)
    })

    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimer()
      resolve({
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        stdout,
      })
    })
  })
}
