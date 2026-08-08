# feishu-coding-agent

用**飞书**远程驱动本机 **Cursor / Kiro**（后续可扩展 Claude Code）的多引擎宿主。

- 飞书连接：[`feishu-agent-bridge`](https://github.com/yucheng1207/feishu-agent-bridge)
- 会话续聊：飞书话题 / 单聊 ↔ 引擎官方 `resume`（不自拼历史）
- 与 IDE UI 无关；Agent 能力对齐本机 Headless/CLI

## 架构

```
飞书 → feishu-agent-bridge → feishu-coding-agent
                               ├─ SessionStore（话题绑定）
                               ├─ CursorRunner（agent CLI）
                               └─ KiroRunner（kiro-cli）
```

`feishu-agent-bridge` 只做飞书收发；本仓库负责引擎与会话。

## 快速开始

### 1. 环境

- Node.js ≥ 20
- 本机已安装并可登录：
  - Cursor CLI：`agent`（[Headless](https://cursor.com/docs/cli/headless)）
  - Kiro CLI：`kiro-cli`（[Headless](https://kiro.dev/docs/cli/headless/)）
- 飞书自建应用（机器人 + 事件 `im.message.receive_v1`）

### 2. 配置

```bash
cp .env.example .env
# 填入 FEISHU_APP_ID / FEISHU_APP_SECRET
# 以及 CURSOR_API_KEY 和/或 KIRO_API_KEY
# DEFAULT_CWD 设为你的代码目录
```

推荐本机：`FEISHU_TRANSPORT=ws`，飞书开放平台选 **使用长连接接收事件**。

### 3. 运行

```bash
npm install
npm run dev          # 开发
# 或
npm run build && npm start
```

健康检查：`http://localhost:8080/health`

## 飞书命令

| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/cursor` / `/kiro` | 切换引擎（换引擎会**新开**会话，上下文不迁移） |
| `/cwd <path>` | 工作目录（会清空 session） |
| `/new` | 当前引擎新会话 |
| `/write on\|off` | 是否允许改文件（默认 off） |
| `/resume <id>` | 绑定已有引擎 session |
| `/status` | 当前绑定 |
| 普通消息 | 在当前绑定上 **resume 续聊** |

群聊需 @机器人（由 bridge 的 `shouldReply` 控制）。

## 会话规则

- **单聊**：整个会话一个 binding
- **群话题**：`root_id || message_id` 作为 key，同一话题多轮续聊
- 持久化：`~/.config/feishu-coding-agent/sessions.json`
- **同一引擎 resume** ≈ 本机对该产品同一会话的 token/效果
- **跨引擎切换** ≠ 同一上下文；会新开会话并提示

## 安全建议

- 设置 `FEISHU_ALLOW_OPEN_IDS` 白名单
- 默认 `DEFAULT_WRITE_MODE=false`，需要改代码时再 `/write on`
- 本机离线/休眠时飞书无法驱动 Agent

## 与 cursor-agent 的关系

[cursor-agent](https://github.com/yucheng1207/cursor-agent) 是早期「仅 Cursor」宿主。多引擎能力以本仓库为准；`feishu-agent-bridge` 继续保持纯 bridge。

## License

MIT
