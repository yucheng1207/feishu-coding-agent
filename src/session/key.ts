import type { FeishuMessageContext } from "feishu-agent-bridge"

/**
 * 飞书窗口 → sessionKey
 * - 单聊：整个 chat 一条会话
 * - 群话题：root_id || message_id（首条用自身 id，回复用 root，二者一致）
 */
export function buildSessionKey(msg: FeishuMessageContext): string {
  if (msg.chatType === "p2p") {
    return `p2p:${msg.chatId}`
  }
  const thread = (msg.rootId || msg.messageId || msg.chatId).trim()
  return `topic:${thread}`
}
