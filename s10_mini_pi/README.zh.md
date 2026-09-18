# s10: mini-pi — 薄内核，厚生态

[English](README.md) · [中文](README.zh.md)

[s09](../s09_compaction/) → `s10`（完）
> *"薄内核，厚生态。"* —— s01–s09 的全部机制装进一个约 330 行的运行时——再用两个证明验证它柔韧不折。

---

## 问题

孤立学懂机制，集成时照样会翻车：压缩与会话树能不能共存？扩展工具与内置工具进的是不是同一个注册表？分叉出去的分支会不会看到分支 A 的压缩条目？最后一章把一切接在一起，跑压力测试。

## 解决方案

mini-pi 是由前面九章组装出的一个运行时：

```
runAgent(store, steps):
  对每个 step:
    append assistant 条目         （s08 会话树，JSONL，id/parentId）
    对每个 toolCall:
      runner.dispatch("tool_call")（s06 扩展 → 可拦截，s07 护栏）
      从唯一注册表执行             （s03 schema 工具 + 扩展工具）
      append toolResult 条目       （s04 content 通道）
    maybeCompact(store)           （s09 每批次后检查，保日志）
  context = store.toMessages()    （s08 投影，尊重 s09 边界）
```

然后是两个集成证明：

1. **护栏在运行中触发。** 脚本化的模型尝试 `rm -rf /`；扩展拦截；模型调整后完成任务。内核未动。
2. **会话分叉。** `branch(firstAssistantId)` + 一条新用户条目 + 第二段脚本运行——两个分支同住一个 JSONL 文件；树渲染中 `< head` 标在另一条路径上；模型可见上下文恰好是分支 B 的路径。

压缩与树完美共存：压缩条目**只是又一个条目**——作为 head 的子节点追加。从它分叉走，它就从投影中消失，却永远留在日志里。

## 对照真实 pi

mini-pi 以 1/500 的规模映照 pi 内部的组合方式：

| mini-pi 部件 | 真实 pi |
|---|---|
| `runAgent` 循环 | `agent-loop.ts` + `agent-session.ts`（产品层接线） |
| 唯一工具注册表 | `agent-session.ts` 的 `_refreshToolRegistry()`——内置与扩展工具合并 |
| 扩展 runner + 护栏 | `extensions/runner.ts` + examples/extensions |
| 会话树 + 压缩条目 | `session-manager.ts` + `compaction/compaction.ts` |
| `toMessages` 投影 | `agent-session.ts` 的请求组装 |
| faux/真实 provider 切换 | `ai/src/providers/faux.ts` 与 40+ 真实 provider |

## 试一下

```sh
node s10_mini_pi/code.ts
```

跟上运行节奏：三个工具回合（含扩展贡献的 `count_files`）、护栏拦截 `rm -rf /` 后模型自我调整、token 预算溢出时紫色压缩条目出现，然后分叉——结尾的树展示**两个分支同住一个文件**、head 标在另一条路径上。

接入真实模型（单轮回答模式；把真实工具调用接通是留给你的毕业练习）：

```sh
PI_API_KEY=sk-... node s10_mini_pi/code.ts "Summarize the workspace readme"
```

## 接下来

你已经从第一性原理重建了 pi 的架构。接下来的路：

- **读真东西。** 从 `pi/packages/agent/src/agent-loop.ts` 开始（858 行——其中每个概念你都认识了），然后是 `extensions/types.ts`（让这一切可扩展的契约）。
- **写一个真扩展。** `pi/packages/coding-agent/docs/extensions.md`（120KB）——把你看着被推出内核的权限弹窗、计划模式、MCP 桥亲手造回来。
- **与 learn-claude-code 对照。** 同一个循环、相反的哲学：机制内置 vs 机制外挂。同时理解两者，才算理解整个设计空间。

**薄内核，厚生态。模型自会完成剩下的一切。**
