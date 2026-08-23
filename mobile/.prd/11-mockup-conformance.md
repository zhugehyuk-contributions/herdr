---
title: 목업 대조 — UI acceptance 원장
type: prd
---

# 11 · 목업 대조

**정본**: `.prd/assets/mockup.html` 7화면. **이 문서는 그 정본과 구현의 차이 원장이다.**
QA 절차상 지위 = `.prd/10-mobile-qa.md` §UI 대조 QA(화면 QA의 필수 절반).

**초판 감사**: 2026-08-23, 별도 에이전트, `feat-mobile-client` 읽기 전용.
**사고 경위**: 구현·QA를 주도한 에이전트가 이 정본을 8개 마일스톤 내내 열지 않았다 → `00-driver.md` N0.

## 먼저 — 목업 자신도 전부가 확정은 아니다

`.prd/01-spec.md:55`: *"목업 화면 설계는 **아직 오너 검증 전이다** (하단 네비 · pane 칩 전환 ·
키 액세서리 행 구성)."* **이 3개 요소의 차이는 유저 판정 대상이지 결함이 아니다.**

`mockup-v5-original.html`과 현행은 **보드 01~06이 바이트 동일**(difflib 대조), 07의 차이도
phone 밖 후속 섹션뿐. **두 판이 충돌하는 화면 설계는 없다.**

## 누락 16건 — 목업에 있는데 구현에 없다

| # | 화면 | 항목 | 근거 |
|---|---|---|---|
| 1 | ① | **QR 스캔 화면 전체** (라우트·파서·카메라) | `package.json:80`이 `expo-camera` drop을 **고의로 기록**. 데스크톱 herdr의 `show qr`도 필요 |
| 2 | ① | `수동으로 추가` 진입점 | settings 경유가 유일 |
| 3 | ② | `hub` / `remotes` 섹션 구분 | `app/nodes.tsx:77` 평면 리스트 |
| 4 | ② | FAB `+ add remote` | 없음 |
| 5 | ② | 노드 dot 4종(ok/working/blocked/off) | `app/nodes.tsx:95` **2상태 고정** |
| 6 | ② | `reconnecting… · last seen 2m ago` | #5와 같은 원인 |
| 7 | ③ | `keybindings local\|server` | `src/settings/remote-form.ts:19-30` 필드 부재 |
| 8 | ③ | `auto-update to this client` | 없음 |
| 9 | ③ | 프로브 `✓ reachable · herdr 0.34.1 · protocol 12 · 41ms` | `advisories`는 키 포맷 경고이지 프로브가 아님 |
| 10 | ④⑤⑥ | **back 브레드크럼 전무** (`‹ nodes`/`‹ iq-64`/`‹ llmux`) | `app/h/_layout.tsx:56` `headerShown:false` + 화면 미렌더 |
| 11 | ④ | 워크스페이스 경로 `~/2lab.ai/llmux` | `WorkspaceListRow.tsx:107-118`은 repo/branch만 |
| 12 | ④ | `+` 아이콘 | 없음 |
| 13 | ⑤ | **pane 요약 줄 `└ Running cargo nextest… · 2m41s`** | 목업 acceptance 명시(`:555` *"요약 줄 = `pane.read` {recent, lines:1}"*). `pane.read` 소비자는 히스토리 오버레이뿐 |
| 14 | ⑤ | pane 행 blocked 반전 뱃지 | ⑦에만 있음 |
| 15 | ⑥ | 헤더 우측 **노드명** | `pane/[paneId].tsx:320-322` 삼항 else — **pane이 잡히는 정상 경로에서 소실** |
| 16 | ⑤⑥⑦ | 경과시간 `2m41s`/`4m` 일체 + ⑥ `esc to interrupt` | **서버측 제약** — `agent-display.ts:22-28`: *"herdr's `AgentInfo` carries no timestamp of any kind"* |

## 초과 10건 — 구현에 있는데 목업에 없다

| 항목 | 위치 | 판단 |
|---|---|---|
| `History` 버튼 | `pane/[paneId].tsx:328-337` | **유지** — 누락 #13과 같은 `pane.read` 소비자다. 제거가 아니라 **요약줄을 추가해 대칭**을 맞춘다 |
| 퀵커맨드 `y/n/y↵/↵` | `pane-quick-commands.ts:49-60` | **유지** — M3의 명시 목표이고 목업 목적("누가 나를 기다리나 → y")의 직접 실현 |
| 액세서리 키 **19개**(목업 6개) | `terminal-accessory-herdr-keys.ts:184` | **유저 판정** — `01-spec.md:55`가 미검증으로 표기한 영역 |
| pane 스와이프 전환 | `pane/[paneId].tsx:386` | 유지(칩과 중복이나 무해) |
| stream 요약 + `ConnectionStatusLine` | `pane/[paneId].tsx:346-349` | 유지 — 누락 #9 프로브의 런타임 대응물 |
| staleness · `demo data` 라벨 | `index.tsx:74,78` · `nodes.tsx:52,56` | 유지 |
| settings 푸시 섹션 · `app.json` 번들 섹션 | `settings.tsx:204,294` | 유지 |
| private key/passphrase/host-key 필드 | `RemoteEditor.tsx:34-41` | **유지 필수** — 폰이 직접 ssh하므로 목업의 `ssh target` 한 줄로는 연결 불가 |

## 판정 정정 — 디스패처의 1차 소견 중 틀린 것

**"노드 행이 `3 unknown`"은 설계 차이가 아니다.** `unknown`은 서버 enum의 정식 값
(`src/api/herdr-api-types.ts:17`)이고 `rollupText`(`src/panes/pane-tree.ts:74-86`)는 **모든 non-zero
status를 분해**한다 — 픽스처가 `unknown`을 보낸 **데이터 아티팩트**다. `일치`로 정정.

## 우선순위 — "폰으로 원격 터미널 에이전트를 쓴다" 기준

| 등급 | 항목 | 왜 |
|---|---|---|
| **P0** | #9 프로브, #1 QR, #4 FAB | **앱 단독으로 원격을 못 붙인다.** 지금은 settings 깊숙한 11필드 폼에 **개인키 본문을 폰에서 타이핑**하고, 저장 후 도달 여부를 알 화면이 없다. QR의 존재 이유가 정확히 이 마찰이다. **최소 복구 = 프로브 1줄 먼저, QR은 그 다음** |
| **P1** | #10 back, #15 노드명 | **화면 간 이동이 막힌다.** 목업이 3화면 모두에 `‹`를 그린 건 장식이 아니라 폰에서 트리를 오르내리는 유일한 가시 경로다. #15는 삼항 한 줄 |
| **P2** | #13 요약줄, #5 dot, #11 경로 | **스캔 능력이 죽는다.** #13 없이는 pane 리스트가 "이름+상태 단어"뿐이라 어느 pane을 열지 리스트에서 못 고른다 — 하나씩 열어봐야 한다 |
| **P3** | ④/⑤ 병합 구조, #16 경과시간, 표기 취향 | #16은 **서버 API 이슈로 분리**(클라이언트로 안 닫힌다). ④/⑤는 P1 back과 얽혀 있으니 함께 판단 |

## 감사가 못 본 것

- ⑥ 터미널 **본문 렌더 품질** — 소스만으론 판정 불가(렌더 결과물). 기기 UI QA 대상
- `app/h/_layout.tsx`의 마스터-디테일 사이드바 — 목업에 대응 화면 없음, 폰 폭에선 비활성. 판정 보류
- `src/components/AgentSummary.tsx` 미독 — ④ 뱃지 판정은 `AgentList.tsx:31,36` 분기까지만 근거
- `src/notifications/*` — 목업 7화면에 대응물 없음. M6 기준 별도 판정 필요
