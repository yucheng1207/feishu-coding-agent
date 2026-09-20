import {
  buildMarkdownCard,
  type CardHeaderTemplate,
  type FeishuMessageContext,
  type FeishuService,
} from "feishu-agent-bridge"
import type { SessionStore } from "../session/store.js"

export interface OutboundCardOpts {
  title: string
  markdown: string
  template?: CardHeaderTemplate
  subtitle?: string
  showStopButton?: boolean
}

/** 群话题内优先回当前消息，失败再回话题根，避免掉到主聊天 */
function replyTargets(msgCtx: FeishuMessageContext): string[] {
  const ids = [msgCtx.messageId, msgCtx.rootId, msgCtx.parentId]
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const trimmed = (id || "").trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * 群聊优先话题内 replyCard；失败再试话题根；最后才 sendCard（会进主聊天，尽量避免）。
 * 成功发送后把 message_id 记入 topic alias。
 */
export async function sendOutboundCard(
  service: FeishuService,
  msgCtx: FeishuMessageContext,
  store: SessionStore,
  sessionKey: string,
  opts: OutboundCardOpts,
): Promise<string | null> {
  const sender = service.getSender()
  const card = buildMarkdownCard({
    title: opts.title,
    markdown: opts.markdown,
    template: opts.template ?? "blue",
    subtitle: opts.subtitle,
    showStopButton: opts.showStopButton,
  })

  let sentId: string | null = null
  if (msgCtx.chatType === "group") {
    for (const targetId of replyTargets(msgCtx)) {
      sentId = await sender.replyCard(targetId, card, { replyInThread: true })
      if (sentId) break
    }
  }

  // 群话题会话禁止静默掉到主聊天：宁可再试 text 回复
  const isTopicSession = sessionKey.startsWith("topic:")
  if (!sentId && !isTopicSession) {
    sentId = await sender.sendCard(msgCtx.chatId, card)
  }

  if (!sentId) {
    const fallback = `${opts.title}\n\n${opts.markdown}`
    if (msgCtx.chatType === "group") {
      for (const targetId of replyTargets(msgCtx)) {
        sentId = await sender.replyText(targetId, fallback, { replyInThread: true })
        if (sentId) break
      }
    }
    if (!sentId && !isTopicSession) {
      sentId = await sender.sendText(msgCtx.chatId, fallback)
    }
    if (!sentId && isTopicSession) {
      console.warn(
        `[feishu] 话题回复失败，已跳过主聊天回退 key=${sessionKey} targets=${replyTargets(msgCtx).join(",")}`,
      )
    }
  }

  if (sentId && sessionKey) {
    store.aliasMessage(sentId, sessionKey)
  }
  return sentId
}

/** 短状态/轻量提示仍用 text（处理中等） */
export async function sendOutboundText(
  service: FeishuService,
  msgCtx: FeishuMessageContext,
  store: SessionStore,
  sessionKey: string,
  text: string,
): Promise<void> {
  const sender = service.getSender()
  let sentId: string | null = null
  const isTopicSession = sessionKey.startsWith("topic:")

  if (msgCtx.chatType === "group") {
    for (const targetId of replyTargets(msgCtx)) {
      sentId = await sender.replyText(targetId, text, { replyInThread: true })
      if (sentId) break
    }
  }
  if (!sentId && !isTopicSession) {
    sentId = await sender.sendText(msgCtx.chatId, text)
  }
  if (!sentId && isTopicSession) {
    console.warn(
      `[feishu] 话题文本回复失败，已跳过主聊天回退 key=${sessionKey}`,
    )
  }
  if (sentId && sessionKey) {
    store.aliasMessage(sentId, sessionKey)
  }
}
