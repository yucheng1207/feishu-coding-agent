import type { FeishuMessageContext, FeishuService } from "feishu-agent-bridge"
import type { AppConfig } from "../config.js"
import type { CodingEngine } from "../engines/index.js"
import type { EngineName } from "../config.js"
import { buildSessionKey } from "../session/key.js"
import type { SessionStore } from "../session/store.js"
import { KeyedQueue } from "../util/queue.js"
import { truncateMessage } from "../util/truncate.js"
import { dispatchCommand } from "./commands.js"

export interface MessageHandlerDeps {
  cfg: AppConfig
  store: SessionStore
  engines: Record<EngineName, CodingEngine>
  getService: () => FeishuService | null
}

export function createMessageHandler(deps: MessageHandlerDeps) {
  const queue = new KeyedQueue()

  return async function handleMessage(msgCtx: FeishuMessageContext): Promise<void> {
    console.log(
      `[msg] chat=${msgCtx.chatId} type=${msgCtx.chatType} shouldReply=${msgCtx.shouldReply} root=${msgCtx.rootId || "-"}`,
    )

    if (!msgCtx.shouldReply) {
      console.log("[msg] 群聊未 @，跳过")
      return
    }

    if (
      deps.cfg.allowOpenIds.size > 0 &&
      msgCtx.senderId &&
      !deps.cfg.allowOpenIds.has(msgCtx.senderId)
    ) {
      console.warn(`[msg] 拒绝非白名单用户: ${msgCtx.senderId}`)
      const service = deps.getService()
      if (service) {
        await service.getSender().sendText(msgCtx.chatId, "⛔ 未授权用户")
      }
      return
    }

    const service = deps.getService()
    if (!service) {
      console.error("[msg] FeishuService 不可用")
      return
    }

    const sender = service.getSender()
    const sessionKey = buildSessionKey(msgCtx)
    const content = (msgCtx.content || "").trim()

    const cmd = dispatchCommand(content, sessionKey, deps.store, deps.cfg)
    if (cmd.kind === "noop") return
    if (cmd.kind === "reply") {
      await sender.sendText(msgCtx.chatId, cmd.text)
      return
    }

    // prompt：按 sessionKey 串行
    await queue.enqueue(sessionKey, async () => {
      let binding = deps.store.get(sessionKey)
      if (!binding) {
        const now = new Date().toISOString()
        binding = {
          engine: deps.cfg.defaultEngine,
          sessionId: "",
          cwd: deps.cfg.defaultCwd,
          writeMode: deps.cfg.defaultWriteMode,
          createdAt: now,
          updatedAt: now,
        }
        deps.store.set(sessionKey, binding)
      }

      const engine = deps.engines[binding.engine]
      await sender.sendText(
        msgCtx.chatId,
        `⏳ [${binding.engine}] 处理中…\ncwd: ${binding.cwd}\nsession: ${binding.sessionId || "(new)"}`,
      )

      try {
        const result = await engine.prompt(cmd.text, {
          cwd: binding.cwd,
          sessionId: binding.sessionId || undefined,
          writeMode: binding.writeMode,
          timeoutMs: deps.cfg.agentTimeoutMs,
        })

        deps.store.update(sessionKey, {
          engine: binding.engine,
          cwd: binding.cwd,
          writeMode: binding.writeMode,
          sessionId: result.sessionId || binding.sessionId,
        })

        const footer = `\n\n— ${binding.engine} · session ${result.sessionId || "(unknown)"}`
        await sender.sendText(
          msgCtx.chatId,
          truncateMessage(result.text + footer),
        )
        console.log(`[msg] ok engine=${binding.engine} session=${result.sessionId}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error("[msg] engine error:", message)
        await sender.sendText(msgCtx.chatId, `❌ ${truncateMessage(message, 1500)}`)
      }
    })
  }
}
