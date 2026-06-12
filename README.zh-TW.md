# claude-plugin-codex

在 Codex 中直接諮詢 Claude Code。

[English](./README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | **繁體中文**

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

這個外掛是為希望在既有工作流程中輕鬆借助 Claude Code 的 Codex 使用者而設計。
用平常的語言描述任務，Claude 就會在同一個儲存庫中執行 —— 使用你已登入的
Claude 帳號 —— 並帶回一份細緻的複查結果。

它與 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
互為補充：後者將這兩個工具沿相反方向連接起來。如果你同時使用這兩個
智慧代理，這兩個外掛正好構成一個完整的循環。

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

## 你將獲得

一個 `claude-code` MCP 伺服器（Node 撰寫、零相依），提供六個工具：

- `consult` —— 將任務交給 Claude Code，預設僅提供建議
- `review` —— 對未提交變更或分支進行細緻的唯讀審查
- `consult_status` / `consult_result` / `consult_cancel` —— 管理背景任務
- `setup` —— 檢查 Claude Code 是否已安裝並登入

你不需要直接呼叫這些工具。內建的技能會引導 Codex 根據你的話語自行選擇
合適的工具與選項（`edit`、`background`、`verify`、`resume`）。

## 環境需求

- **Claude Code**，已安裝並登入：

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # 執行一次以完成登入
  ```

  consult 直接沿用你既有的 Claude 登入，因此用量從你的 Claude 訂閱方案中
  扣除，不會產生額外帳單。為求透明，結果中會顯示類似
  `≈$0.42 of plan usage` 的估算值。（只有在你明確設定了
  `ANTHROPIC_API_KEY` 時才以 API 計費，並會如實標示。）

- **Node.js 20+**
- 支援外掛的 **Codex**，Linux 或 macOS。

## 安裝

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

接著問問 Codex：*「Claude 準備好了嗎？」* —— 它會執行 `setup` 工具，若有
需要修正之處，會連同確切的指令一併告訴你。

## 使用方式

### 尋求第二意見

```text
請 Claude 看看這個改動，給點意見。
問問 Claude 這個查詢為什麼慢。
```

預設情況下 Claude 以 plan mode 執行：只調查、只建議，不會更動任何檔案。

### 請求程式碼審查

```text
請 Claude 審查一下我的變更。
請 Claude 以 main 為基準審查這個分支 —— 重點看重試邏輯。
```

伺服器會自行收集 git diff（未提交的變更，或自 base 分支以來的全部改動），
Claude 以唯讀方式進行審查：簡短摘要、做得好的部分、依嚴重程度排列的發現
（附 file:line 參照），以及一個坦率的整體結論。

### 讓 Claude 動手修改

```text
請 Claude 清理一下資料層，並確認仍能正常編譯。
```

當你要求修改時，Codex 會設定 `edit: true`；對於程式碼改動還會加上
`verify: "auto"` —— Claude 完成後，伺服器會對更動的檔案做一次快速語法
檢查，並把結果附在回覆中。

### 耗時較長的任務

```text
請 Claude 重新設計儀表板 —— 慢慢來沒關係。
```

超出快速處理範圍的工作會以背景任務執行。Codex 會告知任務 id，有效率地
等待（`consult_status` 支援長輪詢），完成後呈現結果。你隨時可以詢問狀態
或取消，每次執行都會留下可即時追蹤的日誌：

```bash
tail -f ~/.cache/cc-plugin-codex/logs/latest.log
```

> [!NOTE]
> 前景 consult 在介面上看不到進度，且有 28 分鐘的上限。規模稍大的工作走
> 背景比較舒服 —— 技能會自然地引導 Codex 這麼做。

### 接續上次的工作

```text
請 Claude 把剛才的再打磨一下，順便把測試也修好。
```

工作階段 id 會依目錄記憶，後續請求會延續同一個 Claude 對話。

### 使用你的 Claude Code 技能

Claude 執行時會帶著你在 Claude Code 中安裝的技能：

```text
請 Claude 用 frontend-design 技能重新設計這個頁面。
```

### 選擇模型與 effort

```text
請 Claude 快速、省錢地看一眼。              → effort: low
這個競態條件請 Claude 仔細想想。            → effort: high
用 opus 審查這個設計。                      → model: opus
```

只要說出來，Codex 就會原樣傳遞（`--model` 接受 `sonnet`/`opus`/`fable` 等
別名或完整名稱；`--effort` 為 `low`…`max`）。未指定時，預設模型為
**`fable`** —— 最新的 Claude —— 若訂閱方案無法使用則依序自動退回 `opus`、
`sonnet`。結果的中繼資訊行會顯示實際作答的模型。要更改預設值，請寫入
`~/.config/cc-plugin-codex/settings.json`：

```json
{ "model": "opus", "effort": "medium" }
```

設定 `"model": "inherit"` 則沿用你自己的 Claude 設定。

## verify 政策

`verify` 指令由 MCP 伺服器直接執行、沒有核准關卡，因此基於安全考量受政策
約束。預設政策 `safe` 只允許 `"auto"`，以及不含 shell 運算子的常見建置/
測試工具（npm、pytest、cargo、go、make 等）的單純呼叫。在
`~/.config/cc-plugin-codex/settings.json` 中設定：

```json
{ "verify": "safe" }
```

- `"auto-only"` —— 僅允許 `verify: "auto"`
- `"safe"` —— 預設值，如上所述
- `"all"` —— 允許任意指令；僅在你信任所有能觸及該工具的內容時使用

## 更新

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

更新後請開啟新的 Codex 工作階段：已開啟的工作階段仍使用舊的伺服器行程，
在其下方升級可能導致橋接中斷（工具呼叫會以 "Transport closed" 失敗）。

## 運作原理

```
Codex ──(MCP: consult)──▶ claude-code MCP 伺服器 (Node，零相依)
                               │
                               ├─▶ claude -p  (無頭模式，同一儲存庫,
                               │              沿用登入，非 edit 時為 plan mode)
                               ├─▶ 修改完成後可選擇執行 verify 指令
                               └─▶ 整理後的結果 ──▶ 回傳給 Codex
```

背景任務以獨立（detached）工作行程執行，狀態寫入檔案：45 分鐘看門狗、
並行上限、失效任務自動校正、依行程群組取消 —— 被取消或被遺忘的 consult
絕不會留下仍在執行的 Claude 行程。

## 開發

```bash
npm test        # 以偽造的 claude 執行檔跑完整測試套件 —— 快速且零用量
npm run test:live   # 使用真實 claude 的選擇性煙霧測試
```

## 授權

[MIT](./LICENSE)
