# s06: 扩展系统 — 内核只搭台，扩展来唱戏

[English](README.md) · [中文](README.zh.md)

[s05](../s05_provider_matrix/) → `s06` → [s07](../s07_minimal_kernel/) → ... → s10
> *"内核只搭台，扩展来唱戏。"* —— 扩展订阅类型化事件、贡献工具与命令、可以拦截一切——而内核一行不改。

---

## 问题

你的 agent 需要：危险命令前弹权限确认、一个自定义部署工具、出站请求的密钥脱敏、一个 `/release` 命令、每次编辑后的 lint 检查……

传统答案是把每个功能塞进核心：这里加一个 `if (dangerous)` 分支，那里插一个脱敏调用。六个月后，"核心"变成一堆没人敢审的产品特有逻辑，而且一个都卸不掉。

## 解决方案

pi 的答案是事件驱动的扩展系统——它的契约文件是全代码库最重要的单一文件（`extensions/types.ts`，约 1800 行）：

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (ev) => {                 // 真实 pi 有约 40 种事件
    if (isDangerous(ev)) return { block: true, reason: "..." };
  });
  pi.on("before_provider_request", (ev) => {   // 改写出站载荷
    redact(ev.request.messages);
  });
  pi.registerTool({ name: "deploy", ... });    // 贡献能力
  pi.registerCommand("release", ...);
}
```

扩展**从磁盘发现**（项目里的 `.pi/extensions/`、全局的 `~/.pi/agent/extensions/`），由 runner 加载、随事件分发。内核只发射事件——它根本不知道存在哪些扩展。

## 工作原理

**第 1 步 —— 带拦截语义的类型化事件。** handler 收到精确类型的事件（`Extract<ExtensionEvent, { type: "tool_call" }>`）。handler 可返回 `{ block, reason }`——runner 聚合结果、**第一个 block 生效**。拦截是数据，不是异常。

**第 2 步 —— 可变更的钩子。** `before_provider_request` 的 handler 拿到出站载荷对象、原地修改。redactor 扩展替换 `secret-*` 令牌——密钥永远不上网线。

**第 3 步 —— 贡献。** `registerTool` 接入 s03 的同一个工具注册表（schema + handler + 执行模式），扩展工具与内置工具无法区分。`registerCommand` 以同样方式添加斜杠命令。

**第 4 步 —— 发现。** 加载器扫描 `.pi/extensions/` 并动态导入每个模块。本章会向临时项目目录写入一个真实的 `weather.mjs` 并从磁盘加载——与 pi 加载器的流程一致（pi 用 **jiti**，所以扩展可以直接是 TypeScript，无需构建）。

**第 5 步 —— 循环征询 runner。** 执行任何工具前：`runner.dispatch({ type: "tool_call", ... })`。block 变成一条合成的错误 `toolResult`——模型从失败中学会边界，而内核不含一个字节的政策。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| `ExtensionAPI` 契约（约 40 种事件、registerTool/Command/Provider/…） | `pi/packages/coding-agent/src/core/extensions/types.ts` |
| 加载器（jiti、`.pi/extensions/` + 全局目录） | `pi/packages/coding-agent/src/core/extensions/loader.ts` |
| 事件分发 runner | `pi/packages/coding-agent/src/core/extensions/runner.ts` |
| 每工具类型化事件（`BashToolCallEvent` 等） | `extensions/types.ts` |
| 项目级扩展的信任门 | `pi/packages/coding-agent/src/core/trust-manager.ts` |
| `ctx.ui` 通道（select/confirm/notify/组件） | `extensions/types.ts` |

真实 pi 还有一道门：项目级扩展只有在项目被**信任**后才会加载（首次运行询问）——这就是 pi 全部的内置安全机制，s07 将在其上构建。

## 试一下

```sh
node s06_extensions/code.ts
```

看加载日志：`weather` 工具从磁盘而来（紫色 `[ext:weather.mjs]`），`guardrails` 与 `redactor` 内联注册。随后：第 1 轮调用扩展工具；第 2 轮的 `rm -rf` 被**以扩展给出的理由拦截**；出站请求里 `secret-abc123` 变成了 `[REDACTED]`。

## 接下来

pi 命题的所有原料已凑齐。s07 组装终局：权限审批、子代理、MCP 式外部工具——**三者全部是扩展，内核分毫未动。**
