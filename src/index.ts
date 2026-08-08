/**
 * feishu-coding-agent
 * 飞书 ↔ 本机 Cursor / Kiro 多引擎宿主（依赖 feishu-agent-bridge）
 */
import express from "express"
import { createFeishuService, type FeishuService } from "feishu-agent-bridge"
import { assertRuntimeConfig, loadConfig } from "./config.js"
import { createEngines } from "./engines/index.js"
import { createMessageHandler } from "./router/handle-message.js"
import { SessionStore } from "./session/store.js"

const cfg = loadConfig()
const missing = assertRuntimeConfig(cfg)

console.log("=== feishu-coding-agent ===")
console.log(`transport: ${cfg.transport}`)
console.log(`defaultEngine: ${cfg.defaultEngine}`)
console.log(`defaultCwd: ${cfg.defaultCwd}`)
console.log(`writeMode default: ${cfg.defaultWriteMode}`)
console.log(`sessionStore: ${cfg.sessionStorePath}`)
console.log(`CURSOR_API_KEY: ${cfg.cursorApiKey ? "✓" : "✗"}`)
console.log(`KIRO_API_KEY: ${cfg.kiroApiKey ? "✓" : "✗"}`)
console.log(`FEISHU_APP_ID: ${cfg.feishuAppId ? "✓" : "✗"}`)
if (cfg.allowOpenIds.size > 0) {
  console.log(`allowOpenIds: ${cfg.allowOpenIds.size} 个`)
}
if (missing.length) {
  console.warn(`⚠️ 缺少: ${missing.join(", ")}（飞书能力不可用）`)
}

const store = new SessionStore(cfg.sessionStorePath)
const engines = createEngines(cfg)

let feishuService: FeishuService | null = null

const handleMessage = createMessageHandler({
  cfg,
  store,
  engines,
  getService: () => feishuService,
})

async function handleBotAdded(chatId: string): Promise<void> {
  console.log(`[bot] added to ${chatId}`)
  if (!feishuService) return
  try {
    await feishuService
      .getSender()
      .sendText(
        chatId,
        "👋 feishu-coding-agent 已就绪。发送 /help 查看命令；默认引擎可用 /cursor 或 /kiro 切换。",
      )
  } catch (err) {
    console.error("[bot] welcome failed:", (err as Error).message)
  }
}

async function main(): Promise<void> {
  if (!missing.length) {
    try {
      feishuService = await createFeishuService({
        appId: cfg.feishuAppId,
        appSecret: cfg.feishuAppSecret,
        transport: cfg.transport,
        onMessage: handleMessage,
        onBotAdded: handleBotAdded,
      })
      console.log(`📡 Feishu ready (${feishuService.transport})`)
    } catch (err) {
      console.error("⚠️ Feishu init failed:", (err as Error).message)
      feishuService = null
    }
  }

  const app = express()
  app.use(express.json())

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: cfg.transport,
      feishuReady: !!feishuService,
      defaultEngine: cfg.defaultEngine,
      defaultCwd: cfg.defaultCwd,
      timestamp: new Date().toISOString(),
    })
  })

  // HTTP 模式：宿主自行解析 webhook，转成 bridge 同款上下文
  if (cfg.transport === "http" || cfg.transport === "both") {
    app.get(cfg.webhookPath, (req, res) => {
      const challenge = req.query.challenge
      if (challenge) return res.json({ challenge })
      return res.status(400).json({ code: -1, msg: "missing challenge" })
    })

    app.post(cfg.webhookPath, (req, res) => {
      const payload = req.body || {}
      if (payload.type === "url_verification" && payload.challenge) {
        return res.json({ challenge: payload.challenge })
      }

      const eventType = payload.header?.event_type
      const message = payload.event?.message
      const chatId = message?.chat_id || payload.event?.chat_id
      if (message?.message_type === "text" && chatId) {
        try {
          const content = JSON.parse(message.content || "{}")
          const text = content.text || ""
          if (text) {
            const sender = payload.event?.sender
            void handleMessage({
              chatId,
              messageId: message.message_id,
              messageType: message.message_type,
              content: text,
              rawContent: message.content,
              chatType: message.chat_type || payload.event?.chat_type || "group",
              senderId:
                sender?.sender_id?.open_id ||
                sender?.sender_id?.user_id ||
                "",
              rootId: message.root_id,
              createTime: message.create_time,
              shouldReply: true,
            })
          }
        } catch (err) {
          console.error("[webhook] parse error:", (err as Error).message)
        }
      }
      return res.json({ code: 0 })
    })
  }

  const server = app.listen(cfg.webhookPort, () => {
    console.log(`HTTP :${cfg.webhookPort}  health=/health`)
    if (cfg.transport === "ws") {
      console.log("飞书请选「使用长连接接收事件」")
    } else {
      console.log(`Webhook: http://localhost:${cfg.webhookPort}${cfg.webhookPath}`)
    }
  })

  // 纯 ws：bridge 已在 create 时启动；run() 会挂起，这里用 HTTP 保活即可
  if (feishuService && cfg.transport !== "http") {
    void feishuService.run().catch((err) => {
      console.error("feishu run error:", err)
    })
  }

  const shutdown = () => {
    console.log("shutting down…")
    server.close(() => {
      const done = () => process.exit(0)
      if (feishuService) {
        void feishuService.shutdown().then(done).catch(() => process.exit(1))
      } else {
        done()
      }
    })
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
