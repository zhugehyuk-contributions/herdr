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
| 7 | ③ | `keybindings local\|server` | ~~필드 부재~~ **닫힘 08-25**: 서버 `remote.set_keybindings`(`98b40b07`) + 폰 세그먼트 컨트롤(`e7a30fba`). §레지스트리 한계는 09 §UU |
| 8 | ③ | `auto-update to this client` | 없음 |
| 9 | ③ | 프로브 `✓ reachable · herdr 0.34.1 · protocol 12 · 41ms` | `advisories`는 키 포맷 경고이지 프로브가 아님 |
| 10 | ④⑤⑥ | **back 브레드크럼 전무** (`‹ nodes`/`‹ iq-64`/`‹ llmux`) | `app/h/_layout.tsx:56` `headerShown:false` + 화면 미렌더 |
| 11 | ④ | 워크스페이스 경로 `~/2lab.ai/llmux` | `WorkspaceListRow.tsx:107-118`은 repo/branch만 |
| 12 | ④ | `+` 아이콘 | 없음 |
| 13 | ⑤ | **pane 요약 줄 `└ Running cargo nextest… · 2m41s`** | ~~근사~~ **목업 원의미로 닫힘 08-25**: `pane.list {recent_lines}` 배치(`6b8c9846`) + 클라이언트 전환(`848f5c37`). 경과시간(`· 2m41s`)만 #16(서버 타임스탬프 부재)으로 잔존 |
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


## P0 #9 프로브 라인 — 구현 (2026-08-23)

목업 `:460`의 `✓ reachable · herdr 0.34.1 · protocol 12 · 41ms`.

`modules/herdr-ssh/src/probe.ts` 신설: **draft를 직접 다이얼**하고(`NativeSshHerdrTransport.connect`),
`herdr --version`을 한 번 돌리고, 시간을 재고, **끊는다**. 연결 재사용이 아니라 새로 다이얼하는 것이
요점이다 — 시험 대상은 **앱이 아직 안 붙은 원격**(편집 중인 draft, 또는 답을 멈춘 저장된 원격)이다.

- 자체 데드라인 **8s**. `connectTimeoutMs` 기본이 20s인데, 포트가 틀렸다는 말을 20초 기다리는 것은
  답이 없는 것과 같다.
- **모든 실패가 throw가 아니라 `{ok:false}`** — 네이티브 모듈 부재·키 거부·포트 오류·PATH에 herdr 없음이
  전부 이 버튼의 정상적인 답이다.
- 실패에도 **경과시간을 싣는다**: "40ms에 거부"와 "8000ms 후 포기"는 잘못된 키와 unreachable 호스트이고,
  그걸 가르는 사람은 유저다.
- `parseHerdrVersion`이 빈 stdout에서 `unknown`을 반환한다 — `''.split(/\s+/)[0]`은 `undefined`가 아니라
  `''`라서 `??`만으로는 구멍 뚫린 줄이 렌더된다(테스트로 고정).

화면: `settings`의 add/edit 폼에 **`test` 버튼**과 결과 줄. 상태는 `app/settings.tsx`가 갖는다 —
`RemoteEditor`는 순수 폼이고 transport를 모른다. 저장 키를 유지하는 편집(`kind:'keepKey'`)에서는
**"키를 다시 입력해야 시험할 수 있다"** 고 말한다(그 화면은 키스토어의 키를 의도적으로 안 들고 있다).

**게이트**: 파서·렌더러 유닛 6건 + `mockup-conformance-mount.test.tsx`에 어포던스 존재 어서션.
110파일/934테스트.

**남은 P0**: #1 QR(데스크톱 herdr의 `show qr` 동반 필요) · #3 add remote가 아직 settings 안(차이-배치).


## UI 대조 QA 2차 — 기기 (2026-08-23, 별도 에이전트, `qa-ui2` @ `9dee96c8`)

픽스처 **80×52**(1차는 240), pane 4 전부 개명, 터미널 타이틀 4종, **ANSI 색 포함**.
`.xterm` **610×777 @ scale 0.675937** → 유효 폰트 **≈10.8px**(1차 240열은 ≈4px).
live 확증 = `LIVEPROOF-A7K2QX`.

### 통과 ✅

- **타이포그래피가 목표에 도달했다.** 판정자 서술: *"1차의 '일반 Material 다크' 인상은 소멸"*.
  Android 기본 `monospace`가 JetBrains Mono의 기하학적 균일 골격을 상당 부분 재현하되 x-height는 덜하다.
- **N1 진짜로 고쳐졌다** — pane 전부 개명한 상태에서 `1-1`/`1-2`/`2-1`, 그리고 `2-1`의 제목이
  pane 라벨 `nextest`가 아니라 에이전트 `claude`라 **폴백이 아님이 갈린다**.
- **칩 잘림 소멸**(3개 완전 노출), **ANSI 4색 정확 재현**, **확대 후 판독 가능**(scale 2, 유효 폰트 ≈32px).
- 새 클리핑 **없음** — agents·nodes·워크스페이스·settings 11필드 2스크롤 전수 확인.

### 내 수리 2건이 **반대 방향**이었다

| | 2차 실측 | 원인 |
|---|---|---|
| **N4 `└` 들여쓰기** | `└` x=**25** vs 행 x=**108**, 카드 **밖** | 1차 리포트("x≈48, 행 밖")를 읽고 패딩을 **줄였다**(18→6). 줄이면 **더 왼쪽**이다. 요구는 오른쪽이었다 |
| **⑥ 헤더 클리핑** | ink가 x=**1079/1080**, `observi`가 **말줄임 없이** 하드 컷. 타 화면은 전부 ≤1035 | 헤더에 노드명이 **두 번**(`‹ qa-lab` + #15 슬롯). 내가 #15로 넣은 슬롯이 폭을 넘겼다 |

**수리**:
- N4 = `paddingLeft: 46` — 행의 `paddingLeft: 40` + 핸들 열(`minWidth: 24`, gap 6)의 **첫 경계**.
  활동 줄은 행 `View`의 **형제**라 그 패딩을 상속하지 않는다. 그걸 몰라서 두 번 다 추측이었다.
- 헤더 = **#15 슬롯 제거.** #15가 지목한 결함은 *"정상 경로에서 노드명이 사라진다"*였고,
  **항상 렌더되는 back 크럼이 그걸 이미 고친다** — 폭을 두 번 쓸 이유가 없다.

### N3 미수리였다 → 수리

칩이 `<paneLabel> <agentLabel>`이라 **`claude claude` · `codex codex`**. 1차의 중복이 목록에서
**칩으로 이사**했을 뿐이다. 첫 슬롯을 **`positionalPaneHandle`** 로 바꿔 목업 `1-1 claude`가 됐다.
(유닛 계약도 갱신: 이름 없는 pane의 폴백이 `ws-1-p3` → `2-1`.)

### 잔여 1건 — 네이티브 헤더

RN Stack 헤더(`← settings`)만 비례 sans로 남아 한 화면에 두 서체가 보인다
→ `headerTitleStyle: { fontFamily: typography.monoFamily }`.

### 못 본 것

화면 ①(라우트 부재) · 화면 ③ 시트 형태 · 화면 ⑦ 요소 단위 ·
**N5 "1차 대비 더 접혔나"의 엄밀 A/B**(수리 전 빌드를 못 돌림 — 판정자의 기하 논증은
*"동일 문자열에서 모노는 비례보다 결코 늦게 줄바꿈하지 않으므로 same-or-worse, 개선은 불가능"*).

## P2/P3 수리 — 노드 리스트 3건 + FAB 반전 (2026-08-23)

| # | 항목 | 상태 |
|---|---|---|
| 3 | `hub` / `remotes` 섹션 | ✅ 분류축은 폰이 지어낸 게 아니라 레지스트리 자신의 `target.type`이다 — `local`이 목업의 `hub`(meta `local`)이고, 그건 `remoteSubtitle`이 이미 그 단어를 렌더하고 있었다. **빈 섹션은 헤딩을 안 그린다**: 폰은 보통 남의 hub에 다이얼하므로 `hub` 그룹이 비고, 상시 빈 제목은 가구다 |
| 5 | 노드 dot 4종 | ✅ `nodeDotState` — disabled→off · 스냅샷 항목 없음→blocked(반전 링) · blocked pane 존재→blocked · working 존재→working · 그 외 ok. **blocked가 working을 이긴다**(`rollupText`가 blocked를 먼저 부르는 것과 같은 우선순위). 렌더는 `AgentStateDot` 재사용 — 노드 점만 pulse하고 아래 pane 점은 spin하면 한 화면에 두 어휘가 된다 |
| 6 | `reconnecting… · last seen 2m ago` | ✅ 서버는 이 값을 안 준다(`remote.list`에 없다) → **앱이 관측한 것만** 쓴다(`mergeLastSeen`, 나이는 스냅샷 자신의 `updatedAt`에서 센다). 콜드 스타트 직후처럼 **한 번도 못 본 원격은 `last seen` 절을 생략한다** — 지어낸 나이보다 짧은 줄이 낫다 |
| — | FAB 반전 | ✅ 목업 `:178-183`은 `background: var(--fg); color: var(--ink)`. 구현은 ink2 외곽선 알약이라 **크롬 한 줄로 읽혔다** — FAB의 목적과 반대다. 램프 최상단으로 올렸다 |

**게이트**: `src/nodes/node-list-model.test.ts` 13건(순수 함수 — dot 우선순위·생략 규칙·5초 그리드가
화면 마운트 없이 재검사된다) + `mockup-conformance-mount.test.tsx`에 #3 어서션(존재가 아니라 **순서**까지:
`remotes`가 `hub` 위에 오면 분할의 의미가 반대가 된다). 111파일/949테스트.

### #14 pane 행 blocked 반전 뱃지 (같은 날)

목업 `:538`의 `<span class="bdg inv">blocked</span>` + `.rowcard.alert`(:148) 밴드.
`src/components/StateBadge.tsx` 신설 — **반전은 blocked를 뜻한다**는 규칙을 한 결정으로 고정하려고
스타일이 아니라 컴포넌트로 뒀다(다른 표면이 "강조"를 원하면 밝기를 쓰지 이걸 쓰지 않는다).

**다른 상태의 상태 단어는 지우지 않았다.** 목업의 조용한 행들은 뱃지가 없지만, `state_labels`는
서버가 bare status보다 구체적인 말을 할 수 있는 자리다(픽스처의 blocked 행이 `waiting for approval`인
것이 그 예). 목업을 맞추려고 그걸 버리면 정보가 준다 — 초과 판정의 원칙(§초과 10건) 그대로.

**게이트가 두 번 약했다**: ①접힌 기본 상태에서는 pane 행이 아예 없어서 초기 트리 어서션은 영원히
엉뚱한 이유로 통과한다 → 워크스페이스를 실제로 펼친 뒤 센다. ②개수만 세면 **반전을 다른 status에
붙여도 이 픽스처에선 1개로 같아서 통과**했다(실측 확인) → 뱃지 텍스트를 blocked pane들의 실제
state label과 대조한다. 두 변이 모두 RED 확증.

**남은 누락**: #1 QR(데스크톱 `show qr` 동반) · #2 수동추가 진입점 · #7 keybindings · #8 auto-update ·
#11 워크스페이스 경로(2차 QA에서 **기기에 존재 확인** → 누락 아니라 차이-내용으로 재분류) ·
#12 `+` 아이콘 · #16 경과시간(서버 API 이슈).
**후보**: 목업 `:490`의 워크스페이스 행 에이전트 칩(`◌ codex blocked`)도 반전이다 — `AgentSummary`는
현재 점+이름만 그린다. 칩 폭이 늘어 클리핑 회귀를 부를 수 있어(1·2차 QA가 각각 잡았다) 기기 확인
라운드와 함께 묶는다.

## UI 대조 QA 3차 — 기기 (2026-08-24, 별도 에이전트, `qa-ui3` @ `168cb28d`)

픽스처 **80×52**, pane 4 전부 개명(`nextest`/`build`/`logs`/`repl` — 위치 핸들과 전부 다르게),
agent 4종(claude working · codex blocked · claude idle · gemini working), ANSI 6색.
live 확증 = 난수 토큰 `ZQ7UI3-16630697-nextest` 렌더 + 픽스처 고유 문자열 0건.
`.xterm` **610×777 @ scale 0.675937**, 셀 폭 12.0 device px.

### 2차 수리 3건 중 2건 PASS, 1건 FAIL

| # | 판정 | 실측 |
|---|---|---|
| ① `└` 들여쓰기 | **PASS** | 행 ink minx=108(4행 전부), `└` ink minx=**130** → 행보다 **+22px 오른쪽**, 카드 안. 2차의 x=25에서 반전 |
| ③ 칩 첫 슬롯 | **PASS** | `1-1 claude`·`1-2 codex`·`1-3 claude`·`1-4 gemini`. **개명 라벨 전무**, id 폴백도 아님 → 수리가 진짜임이 갈렸다 |
| ④ settings 헤더 모노 | **PASS** | 글리프 advance **32px 고정**(잔차 ≤3px) = 모노 서명. 좁은 `i`가 그 격자에 앉는 건 비례 sans로 불가 |
| ② 헤더 우측 클리핑 | **FAIL** | max ink x=**1079**/1080, 엣지 접촉 9줄, `Connec`가 말줄임 없이 **글리프 중간 절단**. 타 화면은 992~1035, 엣지 접촉 0줄. 스와이프해도 불변 = 스크롤 아님 |

### ②는 수리가 헛돈 게 아니라 **잘리는 항목이 옮겨간 것**

중복 노드명 슬롯 제거는 실제로 됐다(back 크럼 `‹ labui3` 생존, 2차에 잘리던 `observing`은 온전).
그런데 오버플로가 **다음 요소(`Connected`)로 밀렸을 뿐**이다. 예산 초과한 행에서 항목 하나를 빼면
**무엇이 잘리는지만 바뀐다** — 3라운드에 걸쳐 같은 x=1079를 세 번 측정한 것이 그 증거다.

**수리 (2026-08-24)**: 목업 06 `:587`이 이 체인을 애초에 **터미널 아래 한 줄**(`agentline`:
dot · who · state · 경과)로 둔다. 상단 바에서 `agentStateLabel` + `streamSummary` +
`ConnectionStatusLine` + dot을 통째로 내려 `styles.agentLine`으로 옮겼다. 헤더에 남는 것은
back 크럼 · 핸들 · pane 제목 · History뿐. **클리핑과 목업 불일치가 같은 수리로 닫힌다.**
새 줄의 텍스트는 `flexShrink: 1` — 길어지는 판독이 행을 밖으로 밀지 않고 자기 폭을 내준다.

### 원장에 없던 새 항목 (판정자가 화면 ⑦ 요소 단위를 처음 열었다)

| 항목 | 판정 | 조치 |
|---|---|---|
| agents 우측 슬롯이 **pane 라벨**(`build`/`nextest`), 목업 07은 **pane id**(`1-2`) | 차이-내용 | ✅ 수리 — `agentPaneHandle`(`manual_label→pane_id`)은 **어떤 픽스처에서도** 목업 표기를 못 낸다. `buildFleetAgentRows`가 pane 목록에서 위치 핸들을 계산해 행에 싣는다(`groupPanesByTab` 재사용 — 같은 pane이 목록·칩·agents에서 한 핸들을 갖는다). **N1/N3와 같은 클래스인데 이 화면만 미적용이었다** |
| agents 3번째 줄이 상태 반복, 목업은 agent **메시지** | 차이-내용 | 미수리 — `--message`가 픽스처에 안 실렸다. 서버 필드 확인 필요 |
| 키바 2행(19키), 목업 06은 1행 6키(`ctrl`·`⌘V` 포함) | 초과 + 차이-내용 | **유저 판정**(`01-spec.md:55` 미검증 영역) |
| nodes 섹션 헤더 부재 | 누락 | ✅ 이미 수리됨(#3, `cf157b9f`) — 3차 리그가 그 이전 커밋이라 안 보였다 |
| 워크스페이스 행이 목업 한 줄 vs 구현 확장행 | 차이-배치 | P3, 미수리 |
| `History`·`observing`·요약줄·git branch | 초과 | 유지 판정(§초과 10건 원칙) |

### 회귀 — 전부 유지

전역 모노 인상 · N1(행 제목=에이전트명) · 칩 잘림 0 · 새 클리핑은 pane 헤더 1건뿐(전수 확인) ·
**ANSI 6색 실측 확증**(RED/GREEN/YELLOW/BLUE/MAGENTA/CYAN, 원장의 판정불가 해소) ·
**핀치 scale 0.676→1.649(2.44×)에 `.xterm` 610×777 불변** = 그리드 미붕괴.

### 절차 결함 1건 (판정자가 브리프를 안 따랐기에 사고가 안 났다)

브리프가 `HERDR_SOCKET_PATH`를 "unset하라"고 했는데, **unset하면 herdr가 유저 프로덕션 소켓으로
폴백한다.** 판정자가 의도(격리)를 살려 `/tmp` 경로로 명시 오버라이드했다. → `.prd/10` §라이브 랩
재구축을 정정(⛔ 블록). 격리 변수를 지우는 것이 격리를 깨는 동작이었다.

## UI 대조 QA 4차 — 기기 (2026-08-24, 별도 에이전트, `qa-ui4` @ `ef9c7008`)

픽스처 **80×52**, pane 4 개명(`orchestrator`/`build`/`review`/`deploy` — 위치 핸들과 다르게),
agent 4상태, ANSI 6색, 깊은 버퍼 pane **836행**. live 확증 = 난수 토큰 `ZQ4-LIVE-20529DF1`.
격리는 `HERDR_SOCKET_PATH=/tmp/labui4/herdr.sock` **명시 오버라이드**(3차의 절차 정정 적용),
per-PID `lsof`로 `~/.config/herdr` 참조 0건, 유저 프로덕션 herdr 76개 생존.

### ② 헤더 클리핑 — **PASS** (3라운드 만에)

| 화면 | max ink x | 엣지 접촉(=1079) |
|---|---|---|
| pane 화면 4종 전부 | **1012** | **0줄** |
| agents / nodes / pane list / settings | 992 / 1034 / 1035 / 439 | 0줄 |

3차 = 1079 / 엣지 **9줄** / `Connec` 글리프 중간절단. 이번 = 1012 / 0줄 / 절단 0.
pane 화면 4종이 모두 1012인 이유: 이제 `History` 우변이 max를 정하고 **상태 체인이 그 자리를 다투지 않는다.**
새 줄(`↻ working observing ● Connected`)은 터미널 아래에 max ink x=**599**로 렌더, back 크럼 생존.

### N2 전환 지연 — **PASS**, 문서 동일성까지 직접 증명

판정자가 CDP 타깃 id(`60BC57B0…`, 4회 전환 전후 불변)에 더해 **JS 전역 마커**
`window.__qaDocId`(문서 재생성 시 소멸)를 심어 4회 전부 생존을 보였다. `.xterm` 610×777 불변.
60fps 녹화 실측:

| 전환 | 백지 | 내용 도달 |
|---|---|---|
| → 깊은 버퍼(836행) | **0ms** | 50ms |
| 깊은 버퍼 복귀 | **0ms** | ≤17ms |
| 스와이프 | **0ms** | 233ms(180ms 제스처 포함) |

전 상태 = 스와이프 184ms + ~530ms, 깊은 버퍼 복귀 시 **백지 3s / 내용 15s**.

### 회귀 — 전수 통과

칩 위치 핸들 · 칩 잘림 0(스크롤 스트립) · ANSI 6색 · settings 모노 · 전역 모노 · 핀치 후 기하 불변 ·
blocked 반전 뱃지+밴드 · **agents 행 우측 = pane id**(3차 지적 수리 확증) · `REMOTES` 섹션 · FAB 반전.

`HUB` 헤더 부재는 **설계대로**(원격 2개가 다 ssh — 빈 그룹은 헤더를 안 그린다).
`└` 활동줄은 **판정불가**: `paneActivityLabel`은 터미널 타이틀이 identity와 다를 때만 줄을 낸다
(bash 프롬프트 pane은 null). 재현하려면 장시간 명령으로 타이틀을 세운 픽스처가 필요하다 — 픽스처 요건에 추가.

### 신규 FAIL → 수리 — 다이얼 실패 원격이 행째로 증발했다

일부러 심은 죽은 원격(`10.0.2.2:2399`)이 **행도 에러도 없이** 안 나왔다. 헤더는 `1 nodes`.

사슬: `fleetOf(connections)`가 **살아있는 connection에서만** `remotes`를 만들고
(`live-snapshot-loader.ts:100`), 실패한 다이얼은 connection이 아니라 문자열이 되며
(`app-connections.ts:213-228`), 부분 실패면 `dataSourceOf`가 `'live'`라 실패 원격을 이름 대는
`dialFailureMessage`가 도달 불가(`herdr-data-provider.tsx:107-132`).
**결과적으로 #6 `reconnecting…` 분기는 구현도 유닛테스트도 있는데 라이브 경로가 입력을 영영 안 줬다** —
로더 자신의 docstring(`:87-89`)과도 모순이었다(그 보장은 "다이얼은 뚫렸다가 JSON이 실패한" 경우에만 성립).

**수리**: 설정된 레지스트리를 로더까지 흘린다. `DialedRemotes.configured`(전량) →
`RemoteDialOutcome.configured?` → `fleetOf(connections, configured)`가
**dialled → listed 미지 → configured 미지** 순으로 병합(id dedup, 순서가 계약).

구현자가 스펙에서 의도적으로 벗어난 지점 1개, 그리고 그게 옳다: 레지스트리를 `configs`(리트라이
`only` 필터 결과)가 아니라 `all`에서 만들었다 — 키 거부처럼 **치명적 실패는 `retryableIds`에서 빠지므로
다음 라운드 `only`에 영영 없고**, `configs` 기반이면 그 원격의 행이 라운드 2에서 다시 사라진다.
`unchanged()`엔 identity가 아니라 값 비교(`sameFleet`)를 넣었다 — 매 라운드 새 배열이라 identity면
rung마다 재발행되고 슈퍼바이저가 전면 재생성된다.

**남은 경계**: **전부 실패**면 여전히 행이 아니라 에러 화면이다(`dataSourceOf`가 `'failed'` → 로더 미선택).
이번 수리는 **부분 실패**에 행을 만든다. `dataSourceOf` 판정 규칙 변경은 별개 결정으로 미룬다.
**기기 미검증** — 다음 라운드 픽스처에 죽은 원격 1개를 상시 포함할 것.

## iOS N1 9차 — 기기(시뮬) (2026-08-24, 별도 에이전트, `qa-ios-n1` @ `ef9c7008`)

**VERDICT: PASS.** 8라운드를 태운 iOS 스와이프가 닫혔다.

### 미확인 전제가 성립했다

`[touchProbe]` **3종(start·first-move·end)이 12회 스와이프 전부**에서 찍혔다(`end`의 `moves` 38~48).
즉 iOS에서 `touchend`는 오고, 이번 수리는 무동작이 아니며 판정은 "수리가 실제로 걸린 상태"에서 났다.
**네이티브 recognizer 중재로 되돌아갈 이유가 없다.**

### 글자 위 스와이프 6/6

y=200/300/400 × 좌·우. 판정자가 ink 스캔으로 글리프 범위(x 0.7~220.3pt)를 먼저 확정하고 **양 끝점이
모두 글리프 안**인 좌표로 측정했다(200→40 / 60→220). 6회 전부 pane 전환, 헤더 핸들·칩 활성 일치.
**RNGH는 12회 내내 `dx=0`인데 전환은 12/12** — 전환 주체가 페이지임이 그대로 갈린다.
관측 pane을 38행으로 리사이즈한 것이 픽스처 요건: 기본 분할이면 글자가 y≈243에서 끊겨 y=300/400이 공백이다.

### 회귀 전부 PASS — 가로를 내줬는데 터미널 가로는 안 뺏겼다

세로 스크롤백 전환 0회(채널 생존은 단발 드래그로 내용 이동을 보여 증명) · 핀치 2.4× ·
**확대 상태 가로 팬에서 전환 0회**(`userScale > 1`이면 페이지가 가로를 되가져가는 분기가 실제로 동작) ·
선택 핸들 드래그(핸들이 제스처를 통째로 소유 → `touch-probe` 0건) · 입력 경로.

### 전환 지연 — 문서 재생성 없음, 중앙값 ≈288ms

`[fit]renderer`가 4회 모두 `tap()` 반환보다 **먼저** 도착(측정값은 상한).
프레임 레벨로는 구 pane 마지막 → 신 pane 첫 프레임 **55~68ms**, 공백 30~37ms.
전 상태(재빌드 523~731ms, 가독까지 0.9~1.0s) 대비 **2.5~3배**.
판정자 자기정정 1건: 영상 mtime 역산(1.19s)은 h264 finalize ~0.9s 때문에 틀린 정렬이었고 폐기했다.

### 권고 1건 → 수리

페이지→RN `pane-swipe` 메시지에 로그가 없어 **"페이지가 안 보냄"과 "보냈는데 드롭됨"이 구별 불가**였다
(판정자가 이 경로를 페이지 쪽 `[touchProbe]`로만 확증할 수 있었던 이유). §JJ가 8라운드를 태운 것이
정확히 이 판별 문제다. → `terminal-webview-pane-swipe-routing.ts` 신설(`routeTerminalQueryReply`와
같은 관용구), `[paneSwipeMsg] ok=… dx=… dy=…`. 값까지 싣는다 — 임계 미달 `dx`는 침묵이 아니라 제3의 상태다.

### 리그 결함 1건 (내 스크립트)

`simctl install`이 `Unable to lookup in current state: Shutdown`으로 **실패했는데 스크립트가
`IOS_N1_SETUP_OK`를 찍었다.** 부팅 후 재설치본이 올라와 있어 결과적으로 정상이었지만,
**셋업 스크립트가 자기 실패를 초록으로 보고한 것** — `set -euo pipefail`이 있어도 마지막 `echo`가
파이프 밖이면 앞선 실패를 삼킨다. iOS 셋업은 install 성공을 **확인**한 뒤 마커를 찍어야 한다.

### iOS 전용 관찰

dev-client 기어 FAB이 `{{348,96},{26,26}}`pt에서 `1-4` 칩 우측을 덮는다 — **릴리즈 빌드엔 없으므로
제품 결함 아님**. 이후 iOS QA는 1-4 칩을 x≤340으로 탭할 것.

## UI 대조 QA 5차 — 기기 (2026-08-24, 별도 에이전트, `qa-ui5` @ `1d898c39`)

4차 `FAIL`의 수리와 iOS 9차 권고 수리가 **기기 검증 없이 HEAD에 얹혀 있었기 때문에** 돈 라운드다.
픽스처에 `.prd/10` §필수 2종을 처음 적용: **죽은 원격**(`lab-dead` → `10.0.2.2:2399`,
`lsof`로 리스너 부재를 주입 전·후 2회 확인) + **타이틀 서는 pane**
(`terminal_title_stripped='cargo nextest run --workspace'`). live 확증 `ZQ5LIVEC6FEA9A6`.

### 4차 FAIL의 수리 — 행은 돌아왔다

`lab-dead` 행 렌더 ✓ · dot **반전 링**(비배경 306px) ✓ · 둘째 줄 **`reconnecting…`**(앱이 한 번도
못 봤으므로 `last seen` 절 없음 = 지어내지 않는 설계) ✓ · 살아있는 것이 위 ✓ · 살아있는 행 롤업 정확 ✓.

### 그런데 헤더는 여전히 `1 nodes`였다 — 수리가 절반이었다

`app/index.tsx:70`이 `snapshot.perRemote.length`(=**답한** 원격)를 렌더했다. 수리는 `remotes`에
configured를 합쳐 **행**을 만들었지만 **카운터는 안 옮겼다.** 같은 화면에서 목록은 2행, settings는
`app.json · 2`, 헤더는 `1 nodes`로 **자기모순**. `live-snapshot-loader.ts:117`의 자기 주석이
`1 nodes`를 바로 그 증상으로 인용하고 있었는데 그 절반이 남아 있었다.

**수리**: `fleetSummary({remotes, answered})` — `2 nodes` 또는 `2 nodes · 1 unreachable`.
- 함대를 센다. "노드가 몇 개냐"의 뜻이 그것이고, 목록 행 수와 같아야 한다.
- 두 번째 절이 반대 방향의 과장을 막는다: **하나가 죽은 함대 2는 건강한 2와 같지 않다.**
  그리고 Agents 홈에서 그 차이가 닿는 자리는 여기뿐이다 — 이 화면의 목록은 답한 원격으로만
  만들어지므로 죽은 원격은 아무것도 기여하지 않아 달리 보이지 않는다.
- **disabled는 함대에 세되 unreachable로는 안 센다** — 아무도 안 걸었으니 잘못된 게 없다
  (`nodeDotState`가 dot에 쓰는 규칙과 동일).
- 기존 마운트 테스트의 계약을 `4 nodes`(다이얼된 수) → **`5 nodes`**(함대, disabled 포함)로 갱신.

### `└` 활동줄 — 판정불가 해소, 통과

`└ cargo nextest run --workspace` 렌더. 행 ink x=**108**, `└` ink x=**130**, delta **+22** —
3차 기준선과 **정확히 일치**.

### 회귀 전 항목 통과

pane 헤더 max ink x **1012** / 타 화면 992~1035, **엣지 접촉 0줄**(4화면), 잘린 단어 0 ·
터미널 아래 상태 줄 ink 48~598 · N2 칩 전환 2회 **백지 0프레임**, CDP 타깃 id 전후 동일 ·
스와이프 **정확히 한 칸**, 이중 전환 없음, `[paneSwipeMsg]` Android에서 **0건**(RNGH 경로가 소비하지
않는 정상) · 핀치 후 `.xterm` 610×777 불변 · 칩 위치 핸들 · blocked 반전 뱃지 · agents 행 pane id ·
FAB 반전 · `REMOTES` 섹션 · ANSI 6색 · settings 모노 · **키 본문 미노출**(`ssh-ed25519 · openssh-key-v1`만) ·
`FATAL EXCEPTION` 0건.

### 원장 재분류 (판정자가 기기에서 구현을 확인)

#2 수동추가 진입점 · #3 add remote 배치 · #11 워크스페이스 경로 · #12 — **구현된 것으로 관측**.
액세서리 키 19개는 우측 잘림으로 **판정불가**(개수 미검) — 어차피 유저 판정 영역.

## UI QA 6차 — 기기 (2026-08-24, 별도 에이전트, `qa-ui6` @ `8a1a9031`)

5차 MUST-FIX의 수리와 **조건 5 신규 화면**을 함께 봤다. 픽스처에 죽은 원격 2개(`10.0.2.2:2299`,
`2298`)를 심어 **3원격 케이스까지** 쟀다. live 확증 `ZQ6-UI6-LIVE-F81052EB` + 랩 sshd `Accepted publickey` 2건.

### 5차 MUST-FIX — PASS

| 픽스처 | 헤더 | 목록 행 | settings |
|---|---|---|---|
| 살아있는1 + 죽은1 | `2 nodes · 1 unreachable` | 2행 | `app.json · 2` |
| 전부 살아있음 | `1 nodes` (둘째 절 **없음**) | 1행 | — |
| 살아있는1 + 죽은2 | `3 nodes · 2 unreachable` | 3행 | — |

헤더 = 행 수 = settings 카운트 **3자 일치**. 5차의 자기모순 해소, 발명 없음.
disabled 하위케이스는 **기기 판정불가** — `app-connections.ts:137`의 `remoteDefinition()`이
`{id,name,target}`만 방출해 `disabled`가 `app.json` 채널에서 표현되지 않는다(유닛이 덮는다).

### ⛔ 그 수리가 만든 신규 회귀 — 같은 교훈을 두 번째로 배웠다

`· 1 unreachable`이 붙자 agents 헤더가 예산을 넘어 **`settings`(액션)가 잘렸다**.
같은 화면·같은 뷰포트에서 문자열 길이만 다르므로 인과가 확정된다:

| 상태 | max ink x | 엣지 접촉 |
|---|---|---|
| `1 nodes` | 992 | 0줄 |
| `2 nodes · 1 unreachable` | **1079** | **12줄** |
| `3 nodes · 2 unreachable` | **1079** | **12줄** |

**`.prd/11` ②와 정확히 같은 형태다** — 예산 초과한 행에서 항목 하나를 줄이면 다른 항목이 잘린다.
그래서 ②와 같은 수리를 했다: **함대 판독을 헤더에서 빼서 아래 요약 줄로 합쳤다**
(`5 nodes · 8 blocked · 16 working`). 그 줄은 같은 종류의 판독을 이미 나르고 전폭을 쓴다.

### 조건 5 화면 — 렌더·권한 PASS, 결함 2건

FAB → `/pair` ✓ · 점선 프레임 190 ✓ · `show qr` 안내 ✓ · `add by hand` → settings ✓ · 전면 모노 ✓ ·
클리핑 0(max ink x 1004) ✓ · 권한 거부1회 재요청 가능 / 거부2회 `USER_FIXED` 전이 ✓ ·
허용 시 카메라 표면 마운트(프레임 휘도 22.00 → 0.00) ✓ · **expo-camera 크래시·ANR 0건**(첫 게이트) ✓

| 결함 | 수리 |
|---|---|
| **`pair`가 `_layout.tsx`에 미등록** → 기본 Stack 헤더가 시스템 **비례 sans**로 `← pair`. 한 화면에 두 서체 + 뒤로가기 이중. **2차 QA가 settings에서 잡았던 결함이 라우트를 통해 재발** | `<Stack.Screen name="pair" options={{headerShown:false}} />` — 이 화면은 자기 크럼바를 갖는다 |
| **`camera blocked` 버튼이 조용한 no-op.** 판정자가 실제로 눌러 확인(다이얼로그 0·네비 0). `.prd/12` Q2가 이름 대고 배제한 형태 | 영구 거부 상태에선 **`open system settings`**(`Linking.openSettings()`)로 교체 — 그 상태에서 유일하게 작동하는 컨트롤이다. 마운트 테스트로 고정(그 상태에서 `allow camera`는 없어야 한다) |

**카메라 캡처 = 판정불가.** AVD가 `hw.camera.back=emulated`인데 프레임을 안 낸다(표면 순흑).
**미검증 잔여**: 스캔 성공 후 경로(찾은 원격 표시 → `use this code` → 폼 프리필). 실기기 QA 항목.

### 회귀

PASS: pane 헤더 1012·엣지 0 · 터미널 아래 상태 줄 · **CDP 타깃 id 전후 동일** · 죽은 원격 행 ·
`REMOTES` · 칩 위치 핸들 · agents 행 pane id · settings 모노 · **키 본문 미노출** · `FATAL EXCEPTION` 0.

**미해결 1건 — N2 칩 전환 백지 프레임.** 판정자가 구 내용(4918) → **0** → 신 내용(5372) 순서를
포착했다. 4차는 60fps 녹화로 **백지 0프레임**을 쟀는데 이번엔 `adb screencap`(~0.5–1s 캐던스)이라
**지속시간이 미측정**이다. 두 측정이 충돌하므로 **다음 라운드에서 60fps 녹화로 재측정**한다 —
측정 방법이 다른 두 결과 중 하나를 고르지 않는다.

### 절차 발견 2건 → `.prd/10` 반영

① `└` 픽스처 레시피가 불충분했다: 타이틀만 세우면 `agentIdentityLabel`의 폴백이 **그 타이틀**이라
identity와 같아져 `paneActivityLabel`이 설계대로 null을 낸다. **에이전트를 붙이고 그와 다른 타이틀**이
필요하다. ② **`uiautomator`가 이제 전 화면 텍스트를 읽는다**(RN 0.83/expo 55) — "못 읽는다"는 stale.

## UI QA 7차 — 기기 (2026-08-24, 별도 에이전트, `qa-ui7` @ `892f9bf0`) — **PASS · MUST-FIX none**

### 6차 MUST-FIX 3건 전부 PASS

| # | 실측 |
|---|---|
| ① 헤더 클리핑 | 앱바 max ink x **992**(6차 1079), 엣지 접촉 **0줄**(6차 12), `settings` 온전. 요약 줄 `2 nodes · 1 unreachable · 1 blocked · 2 working` ink x=932, 안 잘림 |
| ② `pair` 네이티브 헤더 | 네이티브 헤더 **없음**, 자기 크럼만, 단일 mono, 뒤로가기 1개 |
| ③ no-op 버튼 | 2회 거부 → `USER_SET\|USER_FIXED`. 버튼이 `open system settings`로 바뀌고 누르니 top activity가 **`com.android.settings/.spa.SpaActivity`** 로 전이. 그 상태에서 `allow camera` 없음 |

### N2 측정 충돌 — **4차 손을 들어 해소**

`screenrecord` 60fps, 1655프레임/28초, 칩 전환 6회(깊은 버퍼 3회). 터미널 영역 비배경 픽셀
**0px 프레임 = 0개(0ms)**, ≤50/≤200/≤1000px 임계 전부 0개, 전 구간 최소 3880px이며 그 최소 프레임도
실제 내용을 렌더 중. 전환 실재 증거는 전/후 중앙값 42,727 ↔ 3,889의 6회 반전.
**전환은 60fps 입도에서 원자적이다** — 6차의 백지 포착은 `screencap` 캐던스(~0.5–1s)의 산물.

### ⭐ 조건 5 스캔 실경로 — 종단 확증 (1회 시도로 성공)

가상 씬 카메라가 초기 포즈에서 TV 벽을 봐 포스터가 프레임 밖이었고 `sensor set`은 씬 카메라를
안 돌린다(12방위 스윕 통계 동일). **`automation play Walk_to_image_room`** 매크로가 답이었다.

- 스캔 성공 → **즉시 이동 안 함**. `10.0.2.2 — qauser@10.0.2.2:22` + `Key included…` + `use this code`
- **키 본문 화면에 전무** — 길이 표시조차 없고 화면 텍스트에 `BEGIN OPENSSH`/`PRIVATE KEY`/`AAAA` **0건**
- `use this code` → 폼 프리필: id **`qauser-10.0.2.2-22`**(키스토어 charset), host/port/username 정확,
  키 칸 채워짐, **`allow unknown host key` 꺼짐**
- 손상 코드(wifi QR로 벽 교체) → **`This is not a herdr pairing code.`** + `scan again`, 값 노출 0
- `cancel` 후 `remotes · 0` — **키스토어 무오염**
- 10분 경과 경고 정상 발동(`This code was made 43m ago…`)

### 회귀 전수 PASS

pane 헤더 1012·엣지 0 · 터미널 아래 상태 줄 · **CDP 타깃 id 전후 동일** · 죽은 원격 속 빈 링 +
`reconnecting…` · 칩 위치 핸들 · blocked 반전 뱃지 · agents 행 pane id · `REMOTES` · ANSI ·
settings 모노 · 핀치 후 `.xterm` 610×777 불변 · `FATAL EXCEPTION` 0 ·
**`└` 활동줄 렌더**(6차 갱신 레시피대로 에이전트+상이 타이틀 → `└ cargo nextest run`).

### 절차 함정 1건 → `.prd/10` 반영

**`herdrBinary`만으로는 랩이 격리되지 않는다.** ssh exec이 env를 안 실어 원격 herdr이 기본 config
디렉터리로 폴백한다 — 7차 첫 다이얼이 `~/.config/herdr-dev`에 세션을 새로 만들었고 앱은 4-pane 랩
대신 **1-pane 유령**을 보여줬다. 릴리즈 바이너리였다면 **유저 프로덕션 소켓**이다.

**잔여**: 그 첫 다이얼이 만든 `~/.config/herdr-dev/sessions/qaui7`(및 이전 라운드 `qaui1lab`)가
아직 running. `herdr server stop`이 ⛔라 판정자가 손대지 않았고, 정리 여부는 유저 판단으로 남긴다.


## 남은 누락의 성격 — 코드를 더 쓰면 되는 일이 아니다 (2026-08-24 조사)

7차 PASS 이후 남은 목업 누락을 **서버 API 표면으로 판별**했다(`src/api/schema/`).

| # | 항목 | 판별 |
|---|---|---|
| #7 | `keybindings local\|server` | ~~서버에 변경 메서드가 없다~~ → **양 절반 닫힘 (2026-08-25)**: `remote.set_keybindings` 신설(`98b40b07`, set_auto_update 패턴 복제) + 폰 settings 폼 세그먼트 컨트롤(`e7a30fba`, 목업 `:455-458` 표현 그대로). 단 **폰이 직접 다이얼한 박스에는 이 호출이 `remote_not_found`일 수 있다**(서버가 자신을 레지스트리에 미등재, 09 §UU) — 컨트롤은 서버 판정을 그대로 표시하고 로컬 저장은 항상 살아남는다. nodes 행으로의 확장 노출은 **안 한다**(목업 #7의 자리는 settings 폼뿐 — 조건 4 최소주의) |
| #8 | `auto-update to this client` | 메서드는 **있다**(`RemoteSetAutoUpdateParams`, `src/api/schema/mx.rs:35`). 그런데 의미가 갈린다: auto-update는 **클라이언트가 자기 빌드를 원격에 밀어넣는** 동작이고, 폰엔 밀어넣을 herdr 바이너리가 없다. 폰이 붙은 **허브**의 동작을 폰이 설정하는 것으로 읽으면 말이 되지만 목업 ③의 "to this client"와는 다른 뜻이다 → **배선하지 않는다 (2026-08-25 확정)**. 같은 라벨로 다른 동작을 하는 컨트롤은 누락보다 나쁘다 — 목업의 의미를 서버가 갖게 되면 그때 배선한다 |
| #1 QR 화면 | — | **닫혔다**(조건 5). 사이드바 `show qr` 컨텍스트 메뉴만 별도 UI 작업으로 남음 — 명령은 `herdr pair` |
| #2 수동추가 · #3 배치 · #11 경로 · #12 | — | 5·6차가 **기기에서 구현 확인** → 원장 재분류 완료 |
| #16 경과시간 | — | 서버 `AgentInfo`에 타임스탬프가 없다. 클라이언트로 안 닫힌다 |

**결론**: 폰만으로 닫을 수 있는 목업 누락은 남아 있지 않다. 남은 것은
①서버 API 신설(#7 keybindings, 그리고 #13을 목업 의미론으로 하려면 `pane.list`의 배치 필드)
②별도 UI 작업(사이드바 `show qr` 컨텍스트 메뉴 — 명령은 `herdr pair`)
③실기기 게이트다.

**"유저 판정"이었던 것은 2026-08-25에 전부 확정됐다**: #8은 배선하지 않고(위), 액세서리 키 19개는
목표 조건 2(모르겠으면 orca)가 결정한다 — `06-open-decisions.md` 결정 8·9·10.

## iOS QA 10차 — 시뮬 (2026-08-24, 별도 에이전트, `qa-ios-8`) — **PASS · MUST-FIX none**

**판정 대상 = HEAD 마이너스 `expo-camera`.** 판정자가 라벨을 스스로 더 정확히 잡았다: 워크트리는
`cbdaab77`이고 브리프가 말한 `3825aee4`는 조상이 아니라 **3커밋 후손**인데, 그 3커밋의
`git diff --name-only`가 **`.prd` 문서 2개뿐(앱 소스 0줄)** 이라 실행 코드는 동일하다.

### Android 7차 수리가 iOS에서도 성립

| 항목 | 실측 |
|---|---|
| agents 헤더 예산 | 앱바 max ink x **386.0**(뷰포트 402), 좌/우 여백 16.0/16.0, **엣지 오버플로 0**. `/ agents`와 `settings` 사이 여유 **192.3px**. 요약 줄 프레임 높이 **18.3 = 1줄**(2줄이면 ~36) |
| `pair` 라우트 | scan 화면 **NavigationBar 0개**, 자기 크럼만 |
| 무카메라 경로 | `open system settings` 有, **`allow camera` 0건**, `add by hand` → settings 도달 |
| 죽은 원격 행 | `lab-dead — reconnecting…`, 헤더 `2 nodes · 1 unreachable` |

**판정자가 자기 소견 2건을 스스로 정정했다** — 둘 다 결함이 아니었다:
- `reconnecting…`에 `last seen`이 없는 건 **설계대로**(`node-list-model.ts:119-120`, 한 번도 못 본 원격)
- live/dead 링 픽셀이 **완전 동일**(각 598px, RGB (209,208,205))한 것을 "반전 링 누락"으로 잡을 뻔했으나,
  `nodeDotState`가 `!entry`와 `blocked pane 보유`를 **같이 `'blocked'`로 보낸다**. 랩의 live 노드에
  blocked 에이전트가 있었으므로 **동일 렌더가 정답**. ⚠️ 다만 **링의 판별력 자체는 이 픽스처로
  격리되지 않았다** — 다음 라운드 픽스처는 live 노드에 blocked를 두지 말 것.

### N2 — 회귀 아님

칩 탭 4회 벽시계 상관 **308/301/290/306ms**(평균 301), 4회 모두 `[fit]renderer`가 `tap()` 반환보다
**90~109ms 먼저** 도착 → 9차와 같은 성질의 **상한**(9차 288ms와 동급, 참값은 더 작다).
**문서 재생성 없음**: 3탭 구간에 `web-ready`/`[fit]init`/`Bundled` **0건**, `[fit]renderer` payload 3건이
완전 동일(`cols:80, scale:0.628125, xtermRows:51`).

### 회귀 — 스와이프 6/6 포함 전부 PASS

`[paneSwipeMsg] ok=true dx=-200 dy=0` / `dx=200 dy=0` ×3쌍 **원문 확인**(이번에 추가한 계측이 기기에서
실제로 찍혔다) · `[touchProbe]` 3종 · **확대 상태 가로 팬 전환 0**(같은 제스처가 비확대에선 6/6 전환 →
줌 적용의 역증명) · 세로 스크롤백 0 · 선택 핸들 드래그 중 전환 0 · 핀치 후 기하 불변 ·
터미널 아래 상태 줄 · 칩 위치 핸들 · blocked 반전 뱃지 · **키 본문 미노출**(`BEGIN OPENSSH` 0) ·
크래시 0(`.ips` 0개) · ANSI 6색.

`settings 모노`는 **판정불가** — 재진입 실패인데 `settings`와 `nodes tab`이 **함께** `hittable=false`라
하네스 아티팩트와 앱 결함이 분리되지 않았다(`.prd/10` 3원인 미분리 시 결함 보고 금지 규칙 적용).

### 절차 — 브리프가 경고한 함정이 실제로 발동했다

런처 "RECENTLY OPENED"가 **stale `localhost:8097`** 를 물어 8109 번들 요청이 **0건**이었다.
딥링크로 교정 후 판정 시작했고, 서빙 트리는 내 트리 고유의 require-cycle 경고로 확증했다.

**픽스처 사실 공개 1건**: `tmux -x 80`이어도 herdr 영역은 **54×51**이고 pane rect은 27/27/54열이다 —
**pane당 80열이 아니다.** 앱은 `xtermCols:80`으로 렌더하므로 본문이 좌측에 감긴다.

---

## iOS QA 11차 — expo-camera 포함 HEAD (2026-08-25, 별도 에이전트, `qa-ios-11` @ `e44f58ee`)

**10차의 "HEAD 마이너스 `expo-camera`" 라벨이 해소됐다.** `VERDICT: PASS · MUST-FIX: none`.

가장 중요한 항목은 **반증(A6)**이다. 판정관이 bare `pod install`로 되돌리자 커밋이 주장한 서명이
그대로 재현됐고(`_setSavedArchiveVersion:` unrecognized selector · "The project 'Pods' is damaged" ·
`isa = PBXProject` 0), `scripts/pods-install.sh` 재실행으로 복구됐다. 수리가 **인과**를 잡은 것이지
우연히 통과한 게 아니라는 증거다.

카메라가 배포 바이너리에 실재하는 것도 확인됐다 — `strings herdr.debug.dylib`에 `ExpoCamera` 136회,
`CameraViewModule` 6회, `AVCaptureSession` 18회. Citadel도 실제 컴파일(`Citadel.swiftmodule`,
dylib에 164회).

`/pair`는 목업 ① 요소가 누락 0건. 권한 거부 경로가 정확히 동작한다(`open system settings` +
"…or add the remote by hand"), 허용 시 `CameraView`가 프레임 안에 마운트되고 크래시 0.
라이브 확증도 위조 불가 토큰으로 받았다 — pane 1-1/1-2에서 `ZQ11-LIVE-PROOF-D1964184`.

**판정불가(시뮬레이터 한계)**: 실제 QR 스캔 성공 · 권한 다이얼로그 버튼 조작 · FAB의 실제 터치.
전부 카메라 부재 또는 자동화 도구 부재 때문이며, **Android에서는 이미 실측**됐다(7차).
남은 것은 실기기 게이트다.

**잔결함 1건 수리**: 라이브 홈이 `1 nodes`로 단복수를 안 맞췄다 → `fleetSummary`가 단수를 낸다.
