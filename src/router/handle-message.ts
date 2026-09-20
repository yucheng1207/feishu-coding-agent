import type {
  CardAction,
  CardActionResponse,
  FeishuMessageContext,
  FeishuService,
} from "feishu-agent-bridge"
import type { AppConfig } from "../config.js"
import type { CodingEngine } from "../engines/index.js"
import type { EngineName } from "../config.js"
import { isAgentCancelledError } from "../engines/agent-cancelled.js"
import { buildSessionKey, shouldHandleGroupMessage } from "../session/key.js"
import type { SessionStore } from "../session/store.js"
import { KeyedQueue } from "../util/queue.js"
import { sendOutboundCard, sendOutboundText } from "../util/feishu-reply.js"
import { ProgressCardUpdater } from "../util/feishu-progress.js"
import { RunRegistry } from "../util/run-registry.js"
import { dispatchCommand } from "./commands.js"

export interface MessageHandlerDeps {
  cfg: AppConfig
  store: SessionStore
  engines: Record<EngineName, CodingEngine>
  getService: () => FeishuService | null
}

export interface MessageHandlers {
  handleMessage: (msgCtx: FeishuMessageContext) => Promise<void>
  handleCardAction: (action: CardAction) => Promise<CardActionResponse>
}

function isAllowedSender(deps: MessageHandlerDeps, senderId: string): boolean {
  if (deps.cfg.allowOpenIds.size === 0) return true
  return Boolean(senderId && deps.cfg.allowOpenIds.has(senderId))
}

export function createMessageHandler(deps: MessageHandlerDeps): MessageHandlers {
  const queue = new KeyedQueue()
  const runRegistry = new RunRegistry()

  async function requestStop(sessionKey: string): Promise<boolean> {
    return runRegistry.cancel(sessionKey)
  }

  async function handleCardAction(action: CardAction): Promise<CardActionResponse> {
    if (!isAllowedSender(deps, action.senderId)) {
      return { toast: { type: "error", content: "未授权用户" } }
    }

    const actionName = action.actionValue.action
    if (actionName !== "stop_agent" && actionName !== "stop_generation") {
      return { toast: { type: "warning", content: "未知操作" } }
    }

    let sessionKey = deps.store.resolveAlias(action.messageId)
    if (!sessionKey) {
      sessionKey = runRegistry.resolveSessionKey(action.messageId)
    }
    if (!sessionKey) {
      return { toast: { type: "warning", content: "会话已失效，请重新 @ 机器人" } }
    }

    const stopped = await requestStop(sessionKey)
    if (!stopped) {
      return { toast: { type: "info", content: "当前没有运行中的任务" } }
    }

    console.log(`[card] stop requested key=${sessionKey} message=${action.messageId}`)
    return { toast: { type: "success", content: "已请求停止" } }
  }

  async function handleMessage(msgCtx: FeishuMessageContext): Promise<void> {
    console.log(
      `[msg] chat=${msgCtx.chatId} type=${msgCtx.chatType} shouldReply=${msgCtx.shouldReply} root=${msgCtx.rootId || "-"} parent=${msgCtx.parentId || "-"}`,
    )

    if (msgCtx.chatType === "group" && !shouldHandleGroupMessage(msgCtx, deps.store)) {
      const senderType = (msgCtx.senderType || "").toLowerCase()
      const key = buildSessionKey(msgCtx, deps.store)
      if (senderType && senderType !== "user" && !msgCtx.shouldReply) {
        console.log(`[msg] 群聊其他机器人/应用消息，跳过 senderType=${senderType}`)
      } else if (msgCtx.hasMentions && !msgCtx.shouldReply) {
        console.log("[msg] 群聊 @ 其他对象（未 @ 本机器人），跳过")
      } else if (deps.store.get(key)?.requireAt) {
        console.log("[msg] 群聊 requireAt=true 且未 @，跳过")
      } else {
        console.log("[msg] 群聊未 @ 且非已绑定话题，跳过")
      }
      return
    }

    if (!isAllowedSender(deps, msgCtx.senderId)) {
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

    const sessionKey = buildSessionKey(msgCtx, deps.store)
    const content = (msgCtx.content || "").trim()

    if (sessionKey.startsWith("topic:") && msgCtx.messageId) {
      deps.store.aliasMessage(msgCtx.messageId, sessionKey)
    }
    if (sessionKey.startsWith("topic:") && msgCtx.rootId) {
      deps.store.aliasMessage(msgCtx.rootId, sessionKey)
    }

    if (content.toLowerCase() === "/stop") {
      const binding = deps.store.get(sessionKey)
      const stopped = await requestStop(sessionKey)
      if (!stopped) {
        await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
          title: "提示",
          markdown: "当前没有运行中的任务。",
          template: "grey",
        })
        return
      }
      const sessionLabel = binding?.sessionId || "(new)"
      await sendOutboundText(
        service,
        msgCtx,
        deps.store,
        sessionKey,
        `🛑 已请求停止…\nsession \`${sessionLabel}\` 会保留，停止后可继续发消息续聊。`,
      )
      return
    }

    const cmd = dispatchCommand(content, sessionKey, deps.store, deps.cfg)
    if (cmd.kind === "noop") return
    if (cmd.kind === "reply") {
      await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
        title: "命令",
        markdown: cmd.text,
        template: "blue",
      })
      return
    }

    await queue.enqueue(sessionKey, async () => {
      let binding = deps.store.get(sessionKey)
      if (!binding) {
        const now = new Date().toISOString()
        binding = {
          engine: deps.cfg.defaultEngine,
          sessionId: "",
          cwd: deps.cfg.defaultCwd,
          writeMode: deps.cfg.defaultWriteMode,
          requireAt: false,
          createdAt: now,
          updatedAt: now,
        }
        deps.store.set(sessionKey, binding)
      }

      const engine = deps.engines[binding.engine]
      const useProgress = deps.cfg.progressEnabled
      let progress: ProgressCardUpdater | null = null
      const abort = runRegistry.register(sessionKey)

      try {
        if (useProgress) {
          const progressMarkdown = [
            `⏳ **[${binding.engine}]** 启动中…`,
            `cwd: \`${binding.cwd}\``,
            `session: \`${binding.sessionId || "(new)"}\``,
          ].join("\n")

          const cardId = await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
            title: "⏳ 处理中",
            markdown: progressMarkdown,
            template: "yellow",
            subtitle: binding.engine,
            showStopButton: true,
          })

          if (cardId) {
            progress = new ProgressCardUpdater(service.getSender(), cardId, {
              engine: binding.engine,
              cwd: binding.cwd,
              sessionId: binding.sessionId || undefined,
              updateMs: deps.cfg.progressUpdateMs,
              heartbeatMs: deps.cfg.progressHeartbeatMs,
              textPreview: deps.cfg.progressTextPreview,
              textPreviewChars: deps.cfg.progressTextPreviewChars,
            })
            runRegistry.bindProgress(sessionKey, cardId, async () => {
              const keptSessionId =
                progress?.getSessionId() || binding.sessionId || ""
              if (progress) {
                await progress.finishCancelled(keptSessionId)
              }
            })
          }
        }

        if (!progress) {
          await sendOutboundText(
            service,
            msgCtx,
            deps.store,
            sessionKey,
            `⏳ [${binding.engine}] 处理中…\ncwd: ${binding.cwd}\nsession: ${binding.sessionId || "(new)"}\n\n（停止请发 /stop）`,
          )
        }

        const result = await engine.prompt(cmd.text, {
          cwd: binding.cwd,
          sessionId: binding.sessionId || undefined,
          writeMode: binding.writeMode,
          timeoutMs: deps.cfg.agentTimeoutMs,
          signal: abort.signal,
          onProgress: progress ? (e) => progress!.handleEvent(e) : undefined,
        })

        deps.store.update(sessionKey, {
          engine: binding.engine,
          cwd: binding.cwd,
          writeMode: binding.writeMode,
          sessionId: result.sessionId || binding.sessionId,
        })

        const sessionLabel = result.sessionId || binding.sessionId || "unknown"

        if (progress) {
          await progress.finishSuccess(result.text || "（无输出）", sessionLabel)
        } else {
          await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
            title: "✅ 回复完成",
            markdown: result.text || "（无输出）",
            template: "green",
            subtitle: `${binding.engine} · ${sessionLabel}`,
          })
        }

        console.log(
          `[msg] ok key=${sessionKey} engine=${binding.engine} session=${result.sessionId}`,
        )
      } catch (err) {
        if (isAgentCancelledError(err)) {
          const keptSessionId =
            err.sessionId || progress?.getSessionId() || binding.sessionId || ""
          if (keptSessionId) {
            deps.store.update(sessionKey, {
              engine: binding.engine,
              cwd: binding.cwd,
              writeMode: binding.writeMode,
              sessionId: keptSessionId,
            })
          }
          console.log(`[msg] cancelled key=${sessionKey} session=${keptSessionId || "-"}`)
          if (progress) {
            await progress.finishCancelled(keptSessionId)
          } else {
            await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
              title: "🛑 已取消",
              markdown: [
                "当前任务已中断。",
                "",
                `session: \`${keptSessionId || "(new)"}\``,
                "",
                "可直接发下一条消息继续聊（会 resume 同一会话）。",
              ].join("\n"),
              template: "orange",
              subtitle: binding.engine,
            })
          }
          return
        }

        const message = err instanceof Error ? err.message : String(err)
        console.error("[msg] engine error:", message)

        if (progress) {
          await progress.finishError(message)
        } else {
          await sendOutboundCard(service, msgCtx, deps.store, sessionKey, {
            title: "❌ 处理失败",
            markdown: message,
            template: "red",
            subtitle: binding.engine,
          })
        }
      } finally {
        runRegistry.unregister(sessionKey)
        progress?.dispose()
      }
    })
  }

  return { handleMessage, handleCardAction }
}
