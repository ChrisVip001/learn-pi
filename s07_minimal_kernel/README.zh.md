# s07: 最小内核 — 内核不做的，恰恰是扩展要做的

[English](README.md) · [中文](README.zh.md)

[s06](../s06_extensions/) → `s07` → [s08](../s08_session_tree/) → ... → s10
> *"内核不做的，恰恰是扩展要做的。"* —— 权限、子代理、MCP：三个旗舰特性，内核零改动。

---

## 问题

每个 agent 产品最终都会面对这张功能清单：权限弹窗、隔离上下文的子代理、接外部工具的 MCP、计划模式、todo、后台 bash。行业默认做法是把它们造进核心。核心膨胀、审查面膨胀，每个用户都得背着全部功能——想要的不想要的。

pi 的反向命题来自它自己的 README：*"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."*（刻意不内置。）本章就是对这个命题成立的证明。

## 解决方案

拿起 s06 的内核——**原封不动，约 60 行**——把三个旗舰特性当作普通扩展加上去：

```
approvals 扩展     on("tool_call")   危险 bash 前先询问 answerer
subagent 扩展      registerTool      "task" 工具孵化嵌套 agent，全新 messages[]
mcp 扩展           registerTool      外部服务器工具，带命名空间
```

内核不知道"权限"是什么，没听说过"子代理"，MCP 这个词它都拼不出来。

## 工作原理

**审批 —— pi 从不内置的权限系统。** 扩展订阅 `tool_call`、匹配危险模式、征询 **answerer**——真实 pi 中 `ctx.ui.confirm(...)` 会渲染真正的弹窗；这里用一个无头回调：允许 `git push`，拒绝其他一切。拒绝返回 `{ block, reason }`，内核合成错误结果。注意这个形态：*只在需要时询问*、*政策住在内核之外*、*机制整体可卸载*。

**子代理 —— 把上下文隔离做成一个工具。** 扩展注册 `task` 工具，其 handler 用**全新的 `messages[]`** 和**只读工具集**（只有 `ls`，没有 `bash`、没有 `edit`）孵化一个嵌套 agent 循环。子代理的整个转录留在工具执行内部；只有它的最终文本作为一条普通 `toolResult` 越过边界。父上下文保持干净；子代理无法改任何东西。这正是 pi 文档推荐的模式（`docs/sdk.md`："Build custom tools that spawn sub-agents"）。

**MCP —— 外部工具进同一个池子。** 扩展"连接"一台服务器（此处 mock），列出其工具，以命名空间注册每一个：`github__issues_search`。命名空间保证外部工具永远无法遮蔽内置工具。对模型和内核而言，MCP 工具就只是工具——没有特殊通道。

**循环还是那五行。** 分发 `tool_call` → 被拦截？合成错误。否则查注册表 → 执行 → 追加结果。这个流程里没有任何一步知道工具或拦截来自哪个扩展。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| 审批即扩展模式 | `pi/packages/coding-agent/examples/extensions/` + `docs/usage.md`（"no permission popups"） |
| 经 SDK/扩展工具实现子代理 | `pi/packages/coding-agent/docs/sdk.md`、`examples/extensions/subagent/` |
| 全新 `messages[]` 上下文隔离 | 本章实现的模式；另见 `packages/agent/src/agent-loop.ts`（一个循环，任意嵌套深度） |
| MCP 走包而非内核 | 社区 `pi-mcp` 包以扩展形式安装 |
| 唯一的内置边界：项目信任 | `pi/packages/coding-agent/src/core/trust-manager.ts` |
| 用容器化替代权限 | `pi/packages/coding-agent/docs/containerization.md`（Gondolin 微虚拟机 / Docker / OpenShell） |

## 试一下

```sh
node s07_minimal_kernel/code.ts
```

观察四个回合：① `task` 工具打印缩进的子代理转录——全新上下文、只读工具、只有最后一句话返回。② 带命名空间的 `github__issues_search` 像普通工具一样执行。③ `git push` 触发审批扩展 → **允许**。④ `curl … | sh` → **拒绝**，模型随之调整。这些决策没有一个是内核打印的。

## 接下来

到目前为止会话活在内存里，进程一死就没了。pi 把每个会话持久化成一棵**树**——而不是列表——JSONL 存储、原地分叉、分叉不建新文件。s08 构建会话树。
