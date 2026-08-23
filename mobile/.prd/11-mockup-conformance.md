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


## 수리 진행 (2026-08-23)

| # | 항목 | 상태 |
|---|---|---|
| 10 | back 브레드크럼 ④⑥ | ✅ `‹ nodes`(워크스페이스 화면) · `‹ <노드명>`(터미널). 터미널 라벨이 목업의 `‹ llmux`와 다른 이유: ④⑤가 여기선 한 화면이고 **그 화면의 타이틀이 노드명**이라, 탭이 실제로 착지하는 곳을 이름 부르는 편이 맞다. 임베디드 마스터-디테일에선 노드 리스트가 이미 옆에 있으므로 숨긴다 |
| 15 | 터미널 헤더 노드명 | ✅ 스페이서 뒤 고정 슬롯. 삼항 else 의존 제거 — pane이 잡혀도 남는다 |
| 4 | nodes FAB `+ add remote` | ✅ 목적지는 여전히 settings(**차이-배치 #3은 미해결**). 바뀐 것은 *빈 노드 리스트를 보는 사람이 보는 자리*에 어포던스가 생긴 것 |

**게이트**: `src/app-shell/mockup-conformance-mount.test.tsx` 신설 — 목업 항목 번호로 이름 붙인
어서션 4개. 이 수리들은 **기능이 의존하지 않는 단일 요소**라 리팩터가 지우면 기능 테스트는
전부 green인 채로 사라진다. RED 확증(라벨 하나 바꾸면 잡는다). 108파일/922테스트.

| 13 | pane 요약줄 `└ …` | ✅ **단, 소스가 목업과 다르다 — 아래 §열린 질문** |

**남은 P0**: #9 프로브 라인(다음), #1 QR(데스크톱 herdr 작업 동반).
**남은 P2**: #5 노드 dot 4종, #11 워크스페이스 경로.

## 열린 질문 — 유저 판정이 필요한 분기 2건

### (a) #13 요약줄의 소스: 목업은 `pane.read`, 구현은 터미널 타이틀

목업 acceptance(`:555`)는 *"요약 줄 = `pane.read` {recent, lines:1}"* — **pane의 마지막 출력 줄**이다.
구현은 `terminal_title_stripped`(= 실행 중인 명령)를 쓴다.

**이유**: `pane.read`는 pane당 JSON 호출 1회이고 **B8이 그걸 ssh exec 1회 + 원격 herdr 프로세스 1개로
만든다.** pane 12개짜리 워크스페이스는 리스트를 그리는 데 exec 12회를 쓴다.
`terminal_title_stripped`는 **이미 `pane.list` 페이로드에 실려 온다**(`herdr-api-types.ts:104`) — 공짜다.

**대체가 아니라 분기로 기록한다.** 마지막 출력 줄이 정말 필요한 것이면 올바른 수리는
exec 12회가 아니라 **서버 쪽 배치 필드**(`pane.list`에 마지막 줄을 실어 보내기)다. 유저 판정 대상.

### (b) 목업 자신의 미검증 영역

`.prd/01-spec.md:55`가 **하단 네비 · pane 칩 전환 · 키 액세서리 행 구성**을 오너 검증 전으로 표기.
현재 차이: 액세서리 키 **19개**(목업 6개). 결함이 아니라 유저 판정 대상이다.

---

## UI 대조 QA 1차 — 기기 (2026-08-23, 별도 에이전트, `qa-ui1` @ `cd3c9ebf`, `emulator-5554`)

**조건 4의 첫 실행.** 픽스처: `tmux -x 240 -y 52`, pane 4 / tab 2, **전부 이름 있고 터미널 타이틀이 서로 다름**
(`cargo nextest run --locked` / `waiting for approval` / `vim src/api/server.rs` / `tail -f llmux.log`).
live 확증 = 난수 토큰 `LIVE-PROOF-ZQ7AC2D05F`.

### 수리 4건 — **전부 기기에서 확인** ✅

`#10` 양쪽 · `#15`(**pane이 잡힌 라이브 상태에서** — 삼항 else 제거가 실제로 먹었다) · `#4` · `#13`(4행 전부).

### ⚠️ 최대 발견 — 터미널이 **데스크톱 그리드를 축소해 넣는다**. 화면 ⑥의 존재 이유가 무효화된다

CDP 실측: `.xterm` **1630×777 CSS px**를 뷰포트 **412×634**에 `transform: scale(0.252687)`.

| 결과 | 값 |
|---|---|
| 유효 폰트 | `16px × 0.2527` ≈ **4 CSS px** — 폰에서 **판독 불가** |
| 세로 | `777×0.2527 = 196px` / 634px → **69%가 빈 공간** |
| 좌측 | 첫 글자가 x=0에서 잘림 |

**목업 ⑥의 acceptance는 정반대다**: *"pane 탭 = `AttachTerminal{terminal_id}` — 서버가
**`render_terminal_virtual`로 그 pane만 폰 크기로** 렌더"*.

**그 함수는 서버에 실재한다** — `src/server/render_stream.rs:393`
`render_terminal_virtual(runtime, area)`, `terminal attach` 클라이언트용(`headless.rs:2991`).

즉 이건 버그가 아니라 **§2.3에서 내린 아키텍처 결정의 대가**다. §2.3은 데스크톱을 건드리지 않으려고
**observe**를 골랐고, observe는 `(cols,rows)`를 **로그 줄에만** 넣는다 — 리사이즈를 안 한다.
attach는 공유 PTY를 폰 격자로 **리사이즈하고 잠근다**(`direct_attach_resize_locks`) = 데스크톱 화면도 바뀐다.

**유저 판정이 필요한 3지선다** (내가 고를 수 없다 — 셋 다 대가가 다르다):

| 선택 | 얻는 것 | 잃는 것 |
|---|---|---|
| (a) 현행 observe 유지 | 데스크톱 무간섭 | **넓은 pane은 폰에서 못 읽는다.** 240열이면 4px |
| (b) attach로 전환 | 목업 그대로 폰 격자 | **데스크톱 화면이 폰 크기로 바뀐다** |
| (c) 서버에 per-client 가상 크기 | 둘 다 | **서버 작업** — 클라이언트마다 다른 PTY 크기 지원 |

⚠️ 심각도는 데스크톱 폭에 비례한다. QA 픽스처가 **240열**(극단)이었고, 80열에선 scale 0.628 ≈ 10px로
읽히긴 한다(§AA 실측). 그래도 **"폰으로 원격 터미널을 본다"는 목표 1의 직격**이라 P0다.

### 타이포그래피 — "터미널 네이티브"가 일반 Material 다크로 바뀌었다

목업은 **전역 JetBrains Mono**. 구현은 `monoFamily`가 **컴포넌트 2개뿐**
(`WorkspaceListRow.tsx:205` · `PaneHistoryOverlay.tsx:169`) — 나머지 chrome은 **RN 기본 비례 sans**.
팔레트(모노톤 램프)는 일치하는데 인상이 갈린다.

### 신규 차이 — 원장에 없던 것 (기기에서만 보인다)

| # | 무엇 | 목업 |
|---|---|---|
| N1 | pane id 슬롯에 **이름이 중복 렌더**(`claude claude`) | acceptance `:555` *"pane id = herdr 표기 그대로(`1-1`,`1-2`…)"* |
| N2 | 터미널 헤더 **우측 클리핑** `● Connec…` | spacer로 노드명 우측 고정 |
| N3 | pane 칩이 `claude tab 1 · agents`로 **탭 라벨 중복** → 3번째 칩 잘림 | `1-1 claude` |
| N4 | `#13`의 `└`가 행 들여쓰기 **밖**(x≈48)이라 트리 커넥터가 아무것도 안 가리킨다 | rowcard 내부 |
| N5 | 노드 meta 줄 2줄 접힘(`2 idle` 고아) | 한 줄 |

### 원장 정정 — `#11`은 누락이 아니다

**워크스페이스 경로는 기기에 있다** (`/Users/zhugehyuk/2la…`). 목업은 `~/2lab.ai/llmux`.
→ **`누락` → `차이-내용`** (틸드 축약 없음 + 중간 잘림). 위 누락 목록에서 내린다.

### `#5` 정정 — 노드 레벨 한정

**pane 레벨 dot은 4종이 살아 있다**(codex 반전 링 · claude 스피너 호 · idle 흐린 채움).
누락은 **노드 리스트의 dot 1종 고정**뿐이다.

### 못 본 것 (판정 불가)

화면 ①(라우트 부재로 진입 불가) · 화면 ③ 시트 형태(FAB이 settings로 감) ·
**ANSI 색·굵기 재현**(픽스처가 평문이라 목업의 PASS 초록/err 빨강 대응물 미생성) ·
핀치 확대 후 가독성(기본 진입 상태만 판정) · 화면 ⑦ 요소 단위.
목업을 브라우저에 렌더해 나란히 놓지는 않았다 — HTML 소스 + acceptance 문장 기준.


## 1차 UI QA 후 수리 (2026-08-23)

| 항목 | 수리 |
|---|---|
| **N1** pane id 슬롯 이름 중복(`claude claude`) | `positionalPaneHandle(tabIndex, paneIndex)` 신설 — 목업의 `1-1`을 **위치에서 유도**한다. 와이어엔 그런 필드가 없다(`label`=수동 개명, `pane_id`=`w1:p3`). 두 인덱스 모두 `groupPanesByTab`이 이미 세운 순서라 **화면에 보이는 위치 = 표시되는 핸들** |
| **N3** 칩 탭 라벨 중복 → 3번째 칩 잘림 | 칩 둘째 줄을 `tabLabel` → **`agentLabel`**(목업 `1-1 claude`). 탭 이름은 **접근성 라벨에 남긴다** — 스크린리더가 필요로 하고 시각 사용자는 섹션 헤더에서 읽는다 |
| **N4** `└`가 행 들여쓰기 밖 | 좌측 패딩 18→6 |
| **타이포그래피** | 목업 계약이 `body { font-family: var(--mono) }` — **전역**이다. 라우트 5 + 공유 컴포넌트 6의 **텍스트 스타일 72개**에 `typography.monoFamily` 적용 |

**게이트**: `mockup-conformance-mount.test.tsx`에 타이포그래피 어서션 추가 —
**렌더된 트리**에서 `fontSize`가 있는데 `fontFamily`가 없는 `Text`를 찾는다.
소스가 아니라 렌더를 보는 이유: 존재하지만 적용 안 된 스타일 항목은 소스 검사를 통과하면서 화면을 안 바꾼다.

⚠️ **미검증**: 모노스페이스는 비례 폰트보다 넓다. 1차 QA가 이미 클리핑 3건(N2 헤더 · N3 칩 · N5 노드 meta)을
잡았으므로 **이 변경이 그걸 악화시켰을 수 있다.** 2차 UI QA의 1순위다.
