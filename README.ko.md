# claude-plugin-codex

Codex 안에서 Claude Code에게 작업을 맡겨 보세요.

[English](./README.md) | **한국어** | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

이 플러그인은 지금 쓰고 있는 워크플로 그대로 Claude Code의 도움을 받고 싶은
Codex 사용자를 위한 것입니다. 원하는 작업을 평소 말하듯 설명하면, Claude가
같은 저장소 안에서 — 이미 로그인되어 있는 Claude 계정으로 — 실행되어 꼼꼼한
두 번째 검토 결과를 돌려줍니다.

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)가 두 도구를
반대 방향으로 연결한다면, 이 플러그인은 그 동반자 격입니다. 두 에이전트를
모두 쓰신다면 두 플러그인이 원을 완성합니다.

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

## 제공되는 것

`claude-code` MCP 서버(Node, 의존성 없음)와 다섯 개의 툴:

- `consult` — Claude Code에 작업을 맡깁니다. 기본은 조언 전용입니다
- `consult_status` / `consult_result` / `consult_cancel` — 백그라운드 작업 관리
- `setup` — Claude Code 설치·로그인 상태 점검

이 툴들을 직접 호출할 필요는 없습니다. 함께 제공되는 스킬이 사용자의 말에서
적절한 툴과 옵션(`edit`, `background`, `verify`, `resume`)을 Codex가 스스로
고르도록 안내합니다.

## 요구 사항

- **Claude Code** 설치 및 로그인:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # 한 번 실행해 로그인
  ```

  consult는 기존 Claude 로그인을 그대로 사용하므로 사용량은 Claude 플랜에서
  차감되며, 별도 청구는 없습니다. 투명성을 위해 결과에
  `≈$0.42 of plan usage` 같은 추정치가 표시됩니다. (`ANTHROPIC_API_KEY`를
  직접 설정한 경우에만 API 과금이 되고, 그렇게 표기됩니다.)

- **Node.js 20+**
- 플러그인을 지원하는 **Codex**, Linux 또는 macOS.

## 설치

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

설치 후 Codex에게 *"Claude 준비됐어?"* 라고 물어보세요 — `setup` 툴을 실행해
고쳐야 할 것이 있으면 정확한 명령어와 함께 알려줍니다.

## 사용법

### 두 번째 의견 구하기

```text
이 변경에 대해 Claude의 의견을 들어봐.
이 쿼리가 왜 느린지 Claude에게 물어봐.
```

기본적으로 Claude는 plan mode로 실행됩니다: 파일을 건드리지 않고 조사와
조언만 합니다.

### Claude에게 수정 맡기기

```text
Claude한테 데이터 레이어 정리시키고, 컴파일 되는지도 확인해 줘.
```

변경을 요청하면 Codex가 `edit: true`를 설정하고, 코드 수정에는
`verify: "auto"`를 함께 사용합니다 — Claude가 끝나면 서버가 수정된 파일에
간단한 문법 검사를 돌리고 그 결과를 답변에 덧붙입니다.

### 오래 걸리는 작업

```text
Claude한테 대시보드 리디자인 맡겨 줘 — 천천히 해도 돼.
```

간단한 수준을 넘는 작업은 백그라운드 작업으로 실행됩니다. Codex가 작업 id를
알려주고, 효율적으로 기다렸다가(`consult_status`가 롱폴링을 지원합니다)
끝나면 결과를 보여줍니다. 언제든 상태를 묻거나 취소할 수 있고, 모든 실행은
실시간 로그를 남깁니다:

```bash
tail -f ~/.cache/cc-plugin-codex/logs/latest.log
```

> [!NOTE]
> 포그라운드 consult는 UI에 진행 상황이 표시되지 않고 28분 제한이 있습니다.
> 어느 정도 규모가 있는 작업이라면 백그라운드가 편한 길입니다 — 스킬이
> Codex를 알아서 그쪽으로 이끕니다.

### 이어서 작업하기

```text
Claude한테 방금 그거 다듬고, 테스트도 고치라고 해 줘.
```

세션 id가 디렉터리별로 기억되므로, 후속 요청은 같은 Claude 대화를 이어갑니다.

### 내 Claude Code 스킬 사용하기

Claude는 사용자가 Claude Code에 설치해 둔 스킬과 함께 실행됩니다:

```text
Claude한테 frontend-design 스킬로 이 페이지 리디자인하라고 해 줘.
```

## verify 정책

`verify` 명령은 승인 절차 없이 MCP 서버에서 실행되므로, 안전을 위해 정책으로
제한됩니다. 기본 정책 `safe`는 `"auto"`와, 셸 연산자가 없는 잘 알려진
빌드/테스트 도구(npm, pytest, cargo, go, make 등)의 단순 호출만 허용합니다.
`~/.config/cc-plugin-codex/settings.json`에서 설정합니다:

```json
{ "verify": "safe" }
```

- `"auto-only"` — `verify: "auto"`만 허용
- `"safe"` — 기본값, 위 설명과 같음
- `"all"` — 모든 명령 허용. 이 툴에 닿을 수 있는 모든 것을 신뢰할 때만 사용하세요

## 업데이트

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

## 동작 방식

```
Codex ──(MCP: consult)──▶ claude-code MCP 서버 (Node, 의존성 없음)
                               │
                               ├─▶ claude -p  (헤드리스, 같은 저장소,
                               │              기존 로그인, edit 아니면 plan mode)
                               ├─▶ 수정 후 선택적 verify 명령 실행
                               └─▶ 정리된 결과 ──▶ Codex로 반환
```

백그라운드 작업은 파일 기반 상태를 가진 분리(detached) 워커로 실행됩니다:
45분 워치독, 동시 실행 제한, 죽은 작업 자동 정리, 프로세스 그룹 단위 취소 —
취소되거나 버려진 consult가 Claude 프로세스를 남겨두는 일은 없습니다.

## 개발

```bash
npm test        # 가짜 claude 바이너리로 도는 전체 스위트 — 빠르고 사용량 없음
npm run test:live   # 실제 claude로 도는 옵트인 스모크 테스트
```

## 라이선스

[MIT](./LICENSE)
