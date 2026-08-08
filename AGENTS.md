# AGENTS.md — feishu-coding-agent

## 项目是什么

本机常驻的 **飞书多引擎宿主**：用飞书远程驱动 **Cursor / Kiro**（后续可加 Claude Code）。

依赖 [`feishu-agent-bridge`](https://github.com/yucheng1207/feishu-agent-bridge) 做飞书收发；本仓库负责引擎、会话、命令与策略。

**不是** bridge；不要把飞书协议细节塞进引擎层。早期单引擎仓库 `cursor-agent` 仅作参考，新能力落在本仓。

## 架构

```
飞书 → feishu-agent-bridge → src/index.ts
                               ├─ session/     话题/单聊 → binding
                               ├─ engines/     cursor / kiro
                               └─ router/      /命令 + 消息编排
```

## 关键约定（勿破坏）

1. **一飞书话题（或单聊）+ 一引擎 = 一 session**；续聊走引擎官方 resume，**禁止**宿主自拼大段历史当上下文。
2. **跨引擎**（`/cursor` ↔ `/kiro`）必须新开 session，并提示上下文不迁移。
3. `sessionKey`：`p2p:${chatId}` 或 `topic:${rootId || messageId}`（见 `src/session/key.ts`）。
4. `DEFAULT_CWD` 只是默认工作区；运行时用 `/cwd` 切换（会清空该话题 sessionId）。
5. Cursor 对齐 IDE：**Agent + Auto**（`CURSOR_MODEL=auto`，勿默认 `--mode ask`）。
6. Kiro 对齐 IDE：**Claude Opus 5 + High**（`KIRO_MODEL` / `KIRO_EFFORT`）；可写时 `--trust-all-tools` 接近 Autopilot。
7. 默认安全：`DEFAULT_WRITE_MODE=false`，写文件靠 `/write on`。

## 目录速查

| 路径 | 作用 |
|------|------|
| `src/index.ts` | 启动、飞书回调、HTTP health/webhook |
| `src/config.ts` | 环境变量 |
| `src/session/store.ts` | `~/.config/feishu-coding-agent/sessions.json` |
| `src/engines/cursor.ts` | `agent` CLI |
| `src/engines/kiro.ts` | `kiro-cli` |
| `src/router/commands.ts` | `/help` `/cwd` `/new` `/write` … |
| `src/router/handle-message.ts` | 收消息 → 命令或引擎 |

## 本地依赖

- Node ≥ 20
- PATH 上有 `agent`（Cursor CLI，≠ Cursor.app）和/或 `kiro-cli`
- `ENOENT` / 找不到 agent：安装 `curl https://cursor.com/install -fsS | bash`，或设 `CURSOR_BIN`

## 迭代优先级（参考）

- P1：流式卡片、`/stop`、`/sessions`、引用/附件
- P2：Claude Code 引擎（`engines/claude.ts` + 统一 `CodingEngine` 接口）
- 增强飞书通用能力时改 **bridge**，本仓只消费新 API

## 开发命令

```bash
npm run dev        # tsx watch
npm run typecheck
npm run build && npm start
```

改完保持 TypeScript 严格通过；勿提交 `.env`。
