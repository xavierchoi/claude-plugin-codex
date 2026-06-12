# claude-plugin-codex

在 Codex 中直接咨询 Claude Code。

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | **简体中文** | [繁體中文](./README.zh-TW.md)

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

这个插件面向希望在现有工作流中轻松借助 Claude Code 的 Codex 用户。用平常的
语言描述任务，Claude 就会在同一个仓库里运行 —— 使用你已登录的 Claude 账号 ——
并带着一份细致的复查结果回来。

它与 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
互为补充：后者把这两个工具沿相反的方向连接起来。如果你同时使用这两个
智能体，这两个插件正好构成一个完整的闭环。

```text
you   ▸ have claude redesign the landing page and make sure it still builds

codex ▸ claude-code.consult(prompt=…, edit=true, background=true, verify="auto")
        Started background consult job job-a1b2c3.

codex ▸ 🤝 Claude Code made changes in ~/projects/site.
        Redesigned src/app/page.tsx with a bolder hero and …
        Files Claude touched:
        - src/app/page.tsx
        🔍 Verification: `node --check 'src/app/page.tsx'` → ✅ exit 0
        ( 14 turns · 3m41s · ≈$0.42 of plan usage )
```

## 你将获得

一个 `claude-code` MCP 服务器（Node 编写，零依赖），提供六个工具：

- `consult` —— 把任务交给 Claude Code，默认仅提供建议
- `review` —— 对未提交改动或分支进行细致的只读评审
- `consult_status` / `consult_result` / `consult_cancel` —— 管理后台任务
- `setup` —— 检查 Claude Code 是否已安装并登录

你不需要直接调用这些工具。内置的技能会引导 Codex 根据你的话语自行选择
合适的工具与选项（`edit`、`background`、`verify`、`resume`）。

## 环境要求

- **Claude Code**，已安装并登录：

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # 运行一次以完成登录
  ```

  consult 直接复用你现有的 Claude 登录，因此用量从你的 Claude 套餐中扣除，
  不会产生额外账单。为保持透明，结果中会显示类似
  `≈$0.42 of plan usage` 的估算值。（只有当你显式设置了
  `ANTHROPIC_API_KEY` 时才按 API 计费，并会如实标注。）

- **Node.js 20+**
- 支持插件的 **Codex**，Linux 或 macOS。

## 安装

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

然后问问 Codex：*“Claude 准备好了吗？”* —— 它会运行 `setup` 工具，如有需要
修复的地方，会连同具体命令一起告诉你。

## 使用方法

### 寻求第二意见

```text
让 Claude 看看这个改动，给点意见。
问问 Claude 这个查询为什么慢。
```

默认情况下 Claude 以 plan mode 运行：只调查、只建议，不触碰任何文件。

### 请求代码评审

```text
让 Claude 评审一下我的改动。
让 Claude 以 main 为基准评审这个分支 —— 重点看重试逻辑。
```

服务器会自行收集 git diff（未提交的改动，或自 base 分支以来的全部变更），
Claude 以只读方式进行评审：简短摘要、做得好的地方、按严重程度排列的发现
（附 file:line 引用），以及一个坦诚的总体结论。

### 让 Claude 动手修改

```text
让 Claude 清理一下数据层，并确认还能正常编译。
```

当你要求修改时，Codex 会设置 `edit: true`；对于代码改动还会加上
`verify: "auto"` —— Claude 完成后，服务器会对改动的文件做一次快速语法
检查，并把结果附在回复里。

### 耗时较长的任务

```text
让 Claude 重新设计仪表盘 —— 慢慢来没关系。
```

超出快速处理范围的工作会作为后台任务运行。Codex 会告知任务 id，高效地
等待（`consult_status` 支持长轮询），完成后呈现结果。你随时可以询问状态
或取消，每次运行都会留下可实时跟踪的日志：

```bash
tail -f ~/.cache/cc-plugin-codex/logs/latest.log
```

> [!NOTE]
> 前台 consult 在界面上看不到进度，且有 28 分钟的上限。规模稍大的工作走
> 后台更舒服 —— 技能会自然地引导 Codex 这样做。

### 接着上次继续

```text
让 Claude 把刚才的再打磨一下，顺便把测试也修了。
```

会话 id 按目录记忆，后续请求会延续同一个 Claude 对话。

### 使用你的 Claude Code 技能

Claude 运行时带着你在 Claude Code 中安装的技能：

```text
让 Claude 用 frontend-design 技能重新设计这个页面。
```

### 选择模型与 effort

```text
让 Claude 快速、省钱地看一眼。              → effort: low
这个竞态条件让 Claude 好好想想。            → effort: high
用 opus 评审这个设计。                      → model: opus
```

只要说出来，Codex 就会原样传递（`--model` 接受 `sonnet`/`opus`/`fable` 等
别名或完整名称；`--effort` 为 `low`…`max`）。不指定时，默认模型为
**`fable`** —— 最新的 Claude —— 若套餐无法使用则自动回退到 `sonnet`。
结果的元信息行会显示实际作答的模型。要更改默认值，请写入
`~/.config/cc-plugin-codex/settings.json`：

```json
{ "model": "opus", "effort": "medium" }
```

设置 `"model": "inherit"` 则沿用你自己的 Claude 配置。

## verify 策略

`verify` 命令由 MCP 服务器直接执行、没有审批环节，因此出于安全考虑受策略
约束。默认策略 `safe` 只允许 `"auto"`，以及不含 shell 操作符的常见构建/
测试工具（npm、pytest、cargo、go、make 等）的简单调用。在
`~/.config/cc-plugin-codex/settings.json` 中配置：

```json
{ "verify": "safe" }
```

- `"auto-only"` —— 仅允许 `verify: "auto"`
- `"safe"` —— 默认值，如上所述
- `"all"` —— 允许任意命令；仅当你信任所有能触达该工具的内容时使用

## 更新

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

## 工作原理

```
Codex ──(MCP: consult)──▶ claude-code MCP 服务器 (Node，零依赖)
                               │
                               ├─▶ claude -p  (无头模式，同一仓库,
                               │              复用登录，非 edit 时为 plan mode)
                               ├─▶ 修改完成后可选执行 verify 命令
                               └─▶ 整理后的结果 ──▶ 返回给 Codex
```

后台任务以独立（detached）工作进程运行，状态落盘：45 分钟看门狗、并发上限、
失效任务自动清理、按进程组取消 —— 被取消或被遗忘的 consult 绝不会留下
仍在运行的 Claude 进程。

## 开发

```bash
npm test        # 基于伪造 claude 二进制的完整测试套件 —— 快速且零用量
npm run test:live   # 使用真实 claude 的可选冒烟测试
```

## 许可证

[MIT](./LICENSE)
