# s08: 会话树 — 会话原地分叉

[English](README.md) · [中文](README.zh.md)

[s07](../s07_minimal_kernel/) → `s08` → [s09](../s09_compaction/) → ... → s10
> *"会话原地分叉。"* —— 每个会话一个 JSONL 文件；每个条目携带 `id` + `parentId`；分叉只是移动指针，绝不复制文件。

---

## 问题

真实的 agent 工作是探索式的：*"试试方案 A……不对，回到原地试方案 B。"* 线性历史只能往前走。基于列表的会话只有两个选项：把整段转录复制进新文件（存储爆炸、共享历史悄悄分叉），或者毁掉分支 A（丢失工作成果）。

同样的困境也杀死 resume："继续这个会话，但从那一轮开始"需要对转录做手术。

## 解决方案

pi 的会话格式（v3）把持久层变成**单文件的一棵树**：

```
u1 ── a1 ── fb ── a2        <- 分支 A（"只用 JSONL"）
└── b1 ── t1 ── b2          <- 分支 B（"SQLite + JSONL"），从 u1 分出
```

每个条目是一行 JSONL，携带 `id` 和 `parentId`。**head** 是树中一个指针。分叉 = 移动 head；下一次 append 长出新分支——原地、同一个文件、不动任何已有行。

## 工作原理

**第 1 步 —— 追加式持久化。** `append(entry)` 分配 `id`、连接 `parentId = head`、移动 head、写一行 JSON。没有任何东西被重写——崩溃安全、git 可 diff。

**第 2 步 —— 分叉是指针移动。** `branch(entryId)` 设 `head = entryId`，下一次 `append` 产生分叉。分支 A 的条目原封不动、依然可达。

**第 3 步 —— 模型上下文是投影。** `toMessages()` 从 head 走到根、反转、把条目映射为消息对象。LLM 永远只看到一条路径——**树是存储形态，路径是上下文形态**。（扩展可通过 `pi.appendEntry()` 追加 `custom` 条目，投影为系统文本。）

**第 4 步 —— 文件即全部真相。** `load(file)` 重放每一行、重建整棵树——没有边车状态、没有数据库。fork、resume、转录导出都从同一文件派生。

**第 5 步 —— v1 免费迁移。** 旧的线性会话（无 `parentId`）通过"每个条目链接前一行"完成升级——pi 在 `src/migrations.ts` 中自动完成。

## 对照真实 pi

| 课程概念 | 真实位置 |
|---|---|
| JSONL 树格式（v3）、`id`/`parentId` | `pi/packages/coding-agent/src/core/session-manager.ts` + `docs/session-format.md` |
| v1/v2 → v3 自动迁移 | `pi/packages/coding-agent/src/migrations.ts` |
| 树导航 UI（`/tree`） | `pi/packages/coding-agent/src/modes/interactive/components/tree-selector.ts`（48KB 组件） |
| 切换分支时的分支摘要 | `pi/packages/coding-agent/src/core/compaction/branch-summarization.ts` |
| 扩展的自定义条目 | `extensions/types.ts` 中的 `pi.appendEntry()` |
| 会话导出（HTML/JSONL）与分享 | `session-manager.ts`、带 highlight.js + mermaid 的导出模板 |
| 替代后端（SQLite） | `pi/packages/session-backends/sqlite-node/` |

## 试一下

```sh
node s08_session_tree/code.ts
```

看树渲染三次：只有分支 A；从 `u1` 分出分支 B（注意 `b1` 的父节点是 `u1`，同一文件）；然后导航回 A 的末端——模型可见上下文缩回 A 的路径。最后 store 仅凭磁盘文件完成重建。

## 接下来

树会长大，上下文窗口会溢出。pi 的压缩从**最新条目倒序回走**、保留一个"近期 token 预算"、寻找合法切点——并有一条铁律：永远不把工具调用和它的结果分开。s09 实现它。
