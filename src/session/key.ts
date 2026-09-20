import type { FeishuMessageContext } from "feishu-agent-bridge"
import type { SessionStore } from "./store.js"

/**
 * 飞书窗口 → sessionKey
 * - 单聊：整个 chat 一条会话
 * - 群话题：优先用 messageAliases 把 bot 消息 root/parent 拉回原话题；
 *   否则 `topic:${rootId || messageId}`
 */
export function buildSessionKey(
  msg: FeishuMessageContext,
  store?: SessionStore,
): string {
  if (msg.chatType === "p2p") {
    return `p2p:${msg.chatId}`
  }

  if (store) {
    for (const id of [msg.rootId, msg.parentId, msg.messageId]) {
      const aliased = store.resolveAlias(id)
      if (aliased) return aliased
    }
  }

  const thread = (msg.rootId || msg.messageId || msg.chatId).trim()
  return `topic:${thread}`
}

/**
 * 群聊是否应处理该消息：
 * - @bot（shouldReply）→ 处理（可新开话题 / 被其他 bot @）
 * - 当前话题开启 requireAt → 未 @ 一律忽略
 * - 其他机器人/应用发的消息（未 @ 本 bot）→ 忽略
 * - 有 @ 但未 @ 本机器人 → 忽略（避免抢答）
 * - 未 @ 但已落在已绑定话题 → 处理（真人续聊）
 * - 其余 → 跳过
 */
export function shouldHandleGroupMessage(
  msg: FeishuMessageContext,
  store: SessionStore,
): boolean {
  if (msg.shouldReply) return true

  const senderType = (msg.senderType || "").toLowerCase()
  if (senderType && senderType !== "user") {
    return false
  }

  // 话题已绑定也不抢答：消息明确 @ 了别人、没 @ 本 bot
  if (msg.hasMentions) return false

  const key = buildSessionKey(msg, store)
  if (!store.has(key)) return false

  // 该话题开启「仅 @ 才回复」
  if (store.get(key)?.requireAt) return false

  return true
}
