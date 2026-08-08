import { config as loadDotenv } from "dotenv"
import { homedir } from "node:os"
import { join } from "node:path"

loadDotenv()

export type EngineName = "cursor" | "kiro"
export type FeishuTransport = "http" | "ws" | "both"

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name]
  if (v === undefined || v === "") return fallback
  return ["1", "true", "yes", "on"].includes(v.toLowerCase())
}

function parseTransport(raw: string | undefined): FeishuTransport {
  const v = (raw || "ws").toLowerCase().trim()
  if (v === "http") return "http"
  if (v === "both" || v === "dual") return "both"
  return "ws"
}

function parseEngine(raw: string | undefined): EngineName {
  const v = (raw || "cursor").toLowerCase().trim()
  if (v === "kiro") return "kiro"
  return "cursor"
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  if (p === "~") return homedir()
  return p
}

export interface AppConfig {
  feishuAppId: string
  feishuAppSecret: string
  transport: FeishuTransport
  webhookPort: number
  webhookPath: string
  cursorApiKey: string
  kiroApiKey: string
  defaultEngine: EngineName
  defaultCwd: string
  defaultWriteMode: boolean
  agentTimeoutMs: number
  allowOpenIds: Set<string>
  sessionStorePath: string
  cursorBin: string
  kiroBin: string
  kiroTrustTools: string
}

export function loadConfig(): AppConfig {
  const allowRaw = process.env.FEISHU_ALLOW_OPEN_IDS || ""
  const allowOpenIds = new Set(
    allowRaw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )

  const defaultCwd = expandHome(
    process.env.DEFAULT_CWD || process.env.WORKSPACE || process.cwd(),
  )

  const sessionStorePath = expandHome(
    process.env.SESSION_STORE_PATH ||
      join(homedir(), ".config", "feishu-coding-agent", "sessions.json"),
  )

  return {
    feishuAppId: process.env.FEISHU_APP_ID || "",
    feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
    transport: parseTransport(process.env.FEISHU_TRANSPORT),
    webhookPort: Number(process.env.WEBHOOK_PORT || 8080),
    webhookPath: process.env.WEBHOOK_PATH || "/webhook/feishu",
    cursorApiKey: process.env.CURSOR_API_KEY || "",
    kiroApiKey: process.env.KIRO_API_KEY || "",
    defaultEngine: parseEngine(process.env.DEFAULT_ENGINE),
    defaultCwd,
    defaultWriteMode: envBool("DEFAULT_WRITE_MODE", false),
    agentTimeoutMs: Number(process.env.AGENT_TIMEOUT_MS || 300_000),
    allowOpenIds,
    sessionStorePath,
    cursorBin: process.env.CURSOR_BIN || "agent",
    kiroBin: process.env.KIRO_BIN || "kiro-cli",
    kiroTrustTools:
      process.env.KIRO_TRUST_TOOLS || "fs_read,fs_write,execute_bash,grep",
  }
}

export function assertRuntimeConfig(cfg: AppConfig): string[] {
  const missing: string[] = []
  if (!cfg.feishuAppId) missing.push("FEISHU_APP_ID")
  if (!cfg.feishuAppSecret) missing.push("FEISHU_APP_SECRET")
  return missing
}
