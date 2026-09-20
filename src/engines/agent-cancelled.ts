/** 用户 /stop 或 AbortSignal 触发的中断；携带 sessionId 以便续聊 */
export class AgentCancelledError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super("Agent 已取消")
    this.name = "AgentCancelledError"
    this.sessionId = sessionId
  }
}

export function isAgentCancelledError(err: unknown): err is AgentCancelledError {
  return err instanceof AgentCancelledError
}
