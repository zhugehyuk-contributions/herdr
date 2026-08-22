# 03 — 선행 차단 요소 (herdr 쪽이 먼저 바뀌어야 하는 것)

앱 코드보다 앞선다. **B1(프로토콜 식별)이 1순위이며 앱의 존재 조건**이고, 나머지는 전부 그다음이다.
B1의 문제 제기는 herdr-mx **#70**("Fleet upgrade window")에 올라와 있다 — 단 **설계가 아니라 토론 이슈**이고,
2026-07-16 생성 이후 **무갱신·코멘트 0** (`gh issue view 70` `[v]`, 2026-08-22 확인).

번호는 조사 문서([`07-research-2026-08-22.md`](./07-research-2026-08-22.md))의 것을 유지하되, **순서는 번호순이 아니라 앱에 미치는 영향순**이다. 빠진 번호의 처분:
- **B3**(컨포먼스 픽스처 부재) — 블로커로 두지 않고 **M0의 산출물로 흡수**했다([`04-milestones.md`](./04-milestones.md) M0).
- **B7**(stale attach 회수 없음) — §2.3의 observe-only 결정으로 **발생하지 않는다.** 제어를 도입하는 M6에서만 되살아난다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

### B1. 프로토콜 **식별** — 1순위, 앱의 존재 조건

> 2026-08-22 전면 정정: 이전 판은 근인을 "완전일치가 7.2일마다 깨진다"로 봤다. 양쪽 트리를 직접 열어보니
> **더 나쁘고 종류가 다른 문제**였다. 아래 표가 근거이며, 이 표 때문에 M0의 정의가 바뀐다([`04-milestones.md`](./04-milestones.md)).

**`PROTOCOL_VERSION`은 이미 레이아웃 식별자로서 죽어 있다** — mx와 upstream이 **같은 정수 20**인데
앱이 의존하는 바로 그 바이트에서 태그가 다르다:

| | mx (`src/protocol/wire.rs`) | upstream/master (`src/protocol/wire.rs`) |
|---|---|---|
| `PROTOCOL_VERSION` | **20** (`:23` `[v]`) | **20** (`:16` `[v]`) |
| `ServerMessage::Terminal` | **13** `[v]` | **2** `[v]` |
| `ClientLaunchMode::TerminalAttach` | **1** `[v]` | **2** — `AppDirectGraphics`가 중간 삽입 `[v]` |
| `Ping` · `Pong` · `RequestFullFrame` | 있음 `[v]` | **없음 (mx 전용)** `[v]` |

앱이 보내는 첫 메시지가 `Hello{…, launch: TerminalAttach}`이고([`02-architecture.md`](./02-architecture.md) §2.2),
앱의 전 화면이 `ServerMessage::Terminal`이다. **정확히 그 둘이 갈라져 있다.**

→ **이 상태에서 등호를 범위로 바꾸면 시끄럽게 거부하던 것이 조용히 오파싱한다.** 호환 창은 안전을 주지 않는다.
필요한 것은 창이 아니라 **레이아웃 식별자**다 (M0-a).

- **막는 것**: `check_client_version`이 older도 newer도 거부한다 (`src/protocol/wire.rs:1218-1237` `[v]`).
  브리지 경로도 같은 등호 게이트를 통과해야 한다 `[i]`.
- **왜 치명적**: 범프 빈도를 측정하면 **79일에 11회, 평균 7.2일마다**다 —
  v9(05-21) v10(05-23) v11(05-24) v12(05-30) v13(06-06) v14(06-13) v15(06-29) v16(07-05) v17(07-17)
  v18(07-23) v19(08-01) v20(08-08) `[v]`. 데스크톱 CLI는 서버와 같이 올라가지만 **앱스토어 바이너리는
  그럴 수 없다.** 유저가 자기 맥에서 `git pull` 한 번 하면 폰 앱이 그 순간 벽돌이 된다.
- **범위**: `MIN_SUPPORTED_PROTOCOL..=PROTOCOL_VERSION` 창 — 함수 1개 + 상수 1개 + 브리지 비교 1곳.
  **단 이것은 레이아웃 지문(M0-a) 위에서만 의미를 갖는다.** #70이 "설계까지 올라와 있다"는 이전 판의 서술은
  과장이었다 — #70은 2026-07-16에 열린 토론 이슈이고 그 뒤 **무갱신·코멘트 0**이다 `[v]`.
  쓸 것은 옵션 1(창) 한 문단뿐이고, 옵션 2·3(degraded read-only / staged fleet update)은 앱과 무관하다. 단 창만으로는 부족하다: 창 안에서 **어떤 구조체 레이아웃이
  동결되는지**도 같이 선언해야 한다. TerminalAnsi 경로를 택하면 동결 대상이 `TerminalFrame` 5필드로 줄어
  이 부담이 크게 작아진다 — 이것도 TerminalAnsi를 고르는 이유다.
- **정책은 orca에서 베낀다**: 클라이언트가 자기 버전 + min-compatible-server를 선언하고, 불일치 시
  재연결 루프가 아니라 **하드 블록 화면**으로 보낸다. 옵셔널 필드 추가는 범프가 아니라고 명문화 `[i]`.

### B2. `ServerMessage` 와이어 태그 동결 테스트 부재

`ClientMessage`에는 태그 순서를 고정하는 테스트가 있다 —
`client_message_wire_tags_preserve_protocol_15_order` (`src/protocol/wire.rs:1383` `[v]`).
**`ServerMessage`에는 대응 테스트가 없다** `[v]`. upstream 머지가 enum 중간에 variant를 하나 끼우면
`Welcome`/`Terminal`의 태그가 조용히 밀리고, 앱은 실패가 아니라 **오파싱**한다.
대응이 필요했던 전례가 코드에 남아 있다(mx variant를 꼬리에 재배치한 주석, `wire.rs` 인근 `[i]`).
→ ClientMessage 테스트의 미러 1개, 약 30줄. **앱 착수 전에 머지되어야 한다.**

### B4. observe는 리플로우가 아니라 좌상단 크롭 — 읽기 화면의 형태를 결정한다

> 2026-08-22 복원: 증류 과정에서 이 항목이 통째로 빠져 있었다. observe를 읽기 경로로 고른 이상 **M2의 1순위 UX 제약**이므로 되살린다.

- **막는 것**: 렌더가 `while y < area.height && rows.next()` 식으로 잘린다 (`src/pane/terminal.rs:1956-1962` `[i]`).
  observe는 PTY를 리사이즈하지 않으므로([`02-architecture.md`](./02-architecture.md) §2.3), 40컬럼 폰이 200×50 pane을 보면
  **좌상단 40×N만** 보인다 — 커서와 최신 출력이 화면 밖이다.
- **메커니즘 확정 (2026-08-22 리시트 실측 `[v]`)**: 프레임은 **pane 크기가 아니라 클라이언트가 선언한 크기**로
  온다 — 클라이언트가 100×30을 선언하자 pane PTY가 23×53인 채로 `TerminalFrame{width:100,height:30}`이 왔다
  (`tests/observe_terminal_ansi.rs`). 서버가 pane 내용을 **폰 뷰포트로 다시 렌더**한다. 그러나 **줄바꿈은
  pane의 컬럼 수에 그대로 묶여 있다**(리플로우 없음). 즉 프레임 크기를 키워도 읽기 문제는 안 풀린다 —
  **pane 폭의 문제**이지 프레임 크기의 문제가 아니다.
- **새 레버 (2026-08-22, upstream v0.8.2 머지) `[v]`**: pane 폭이 이제 **서버 설정 값**이다.
  upstream #2829가 `server.headless_cols` / `server.headless_rows`를 도입했다 —
  `src/config.rs:53-54` `DEFAULT_HEADLESS_COLS: u16 = 120` · `DEFAULT_HEADLESS_ROWS: u16 = 40`,
  읽기 지점 `src/config.rs:96 headless_size()`, 0 검증 `:104`. **머지 전에는 이 상수 자체가 없었다**
  (`git show d06d5333:src/config.rs`에 부재). 위 진단이 "프레임 크기가 아니라 **pane 폭**의 문제"라고
  못박았는데, 바로 그 pane 폭에 처음으로 손잡이가 생긴 것이다.
  - **주의 1 — 기본값은 오히려 나빠졌다**: 헤드리스 그리드가 커져 라이브 pane PTY가 23×53 → **39×93**.
    같은 폰 뷰포트에서 잘려나가는 양이 늘었다.
  - **주의 2 — 서버 전역이다**: 폰을 위해 좁히면 **데스크톱 pane도 같이 좁아진다.** 클라이언트별 설정이
    아니므로 "폰만 좁게"는 이 노브로 안 된다 — 그건 여전히 서버 측 per-client 뷰포트(B4 본체) 작업이다.
  - **따라서**: 이건 B4의 해결이 아니라 **처음 생긴 부분 완화 선택지**다. 단말 1대에 폰 위주로 붙는
    사용 패턴이라면 설정 한 줄로 읽기 문제를 크게 줄일 수 있고, 그 판단은 실기기 확인 후에 한다.
- **왜 치명적**: M2(읽기 전용 v1)가 목적의 절반인데, 그게 잘린 코너를 보여준다. 실기기 전에는 안 보이는 종류의 결함이다.
- **v1 답 (서버 변경 0)**: `Hello`의 cols/rows를 **폰 해상도가 아니라 대상 pane의 실제 크기**로 보낸다(`pane.get` 선조회).
  xterm은 PTY 폭 그대로 렌더하고 폰은 핀치줌/가로스크롤로 본다. observe라서 데스크톱은 그대로다.
  → [`06-open-decisions.md`](./06-open-decisions.md) 결정 2.
- **서버 변경안**: observe 클라이언트별 뷰포트 오프셋(follow-the-cursor 또는 bottom-anchored). CLI 스펙이 이미
  `--cols/--rows`를 예고하고 있어 의도는 있다 (`src/cli/spec.rs:695-700` `[i]`). M6.

### B5. observe는 스크롤백을 못 본다

- **막는 것**: `handle_terminal_attach_scroll`이 `TerminalAttach`만 매치한다 (`src/server/headless.rs:1802-1806` `[i]`).
- **왜**: B4의 v1 완화와 합치면 "보이는 화면 안은 다 보이지만 과거는 못 본다".
- **범위**: 매치를 `TerminalObserve`까지 넓히되 **공유 runtime을 스크롤하면 안 된다**(데스크톱 뷰가 같이 움직인다)
  → per-client 뷰포트가 필요하므로 사실상 B4의 서버 변경안과 같은 작업이다.
  **v1은 xterm 자체 스크롤백 버퍼로 대체**한다(orca는 5000줄 `[i]`). M6.

### B13. TerminalAnsi 프레임은 압축되지 않고 셀마다 재-SGR한다 — 모바일 대역폭

> **2026-08-22 갱신 (upstream v0.8.2 머지) — 아래 "셀마다 재-SGR" 실측은 더 이상 유효하지 않다.**
> upstream #2675(`36074530`)가 `write_all_cells`를 재작성했다: 인접 셀에서 `ESC[row;colH`를 생략하고
> (`next_inline_col`), SGR은 **변경 시에만** 재발행한다(`last_sgr` 메모). 그 함수는 observe 라이브 경로가
> **실제로 지나는** 함수다 — `src/server/render_stream.rs:101` → `BlitEncoder::encode` →
> `src/protocol/render_ansi.rs:483` `if full_redraw { write_all_cells(...) }` `[v]`.
> **재실측**: 100×30 풀 프레임 = **3,276 B 라이브**(`tests/observe_terminal_ansi.rs` 2회),
> TS 클라이언트가 소켓·ssh로 받은 값 3,274 B, fixture 3,292 B — **55,925 → 3,276, 약 17배 축소** `[v]`.
> 셀당 18.6 B → **약 1.09 B/cell**.
> **결과**: 이 블로커의 *크기* 축은 사실상 해소됐다. trinity 리뷰가 남긴 "55KB 프레임을 RN 브리지로
> 마샬링" 리스크는 없어졌고, 아래 완화책(B6 `RetargetTerminal`로 풀 프레임 **빈도**를 줄이는 것)은
> **크기만 놓고 보면 더 이상 load-bearing이 아니다** — B6는 지연 시간 이유로 유지된다(M6 실측 21ms).
> **여전히 참인 것**: `ServerMessage::Terminal`은 지금도 deflate되지 않는다(아래 두 번째 불릿).
> 압축 부재 자체는 변하지 않았고, 바뀐 것은 압축되지 않는 페이로드의 크기다.

> 2026-08-22 신설. `tests/observe_terminal_ansi.rs` 리시트를 돌리다 실측으로 드러났다. **계획에 없던 비용이다.**

- **실측**: 100×30 풀 프레임 1장 = **55,925 바이트 ≈ 18.6 B/cell** `[v]`. `BlitEncoder`가 **모든 셀 앞에**
  `ESC[row;colH` + 전체 SGR를 낸다 — 같은 스타일이 이어져도 런을 합치지 않는다.
- **더 나쁜 것**: `ServerMessage::Terminal`은 **deflate되지 않는다.** 압축은 semantic 분기에만 걸려 있고
  (`src/server/render_stream.rs:87-89` — 주석이 "full frames are ~hundreds of KB of per-cell data"라며 도입 이유를
  적어둔다), ANSI 분기(`:105-123`)는 `encoded.bytes`를 **그대로** 보낸다 `[v]`.
- **함의**: TerminalAnsi를 고른 이유는 "코덱 부담 최소"였는데, 그 경로는 **semantic 경로가 이미 받고 있는
  deflate를 포기하는 경로**이기도 하다. 셀룰러에서 제일 먼저 아플 지점이고, 풀 프레임은 pane 전환 · 재연결 ·
  `RequestFullFrame`마다 나온다. → [`06-open-decisions.md`](./06-open-decisions.md) 결정 1의 비용란에 반영됨.
- **완화 (서버 변경 0)**: 풀 프레임 **빈도**를 줄인다 — B6(`RetargetTerminal`)가 pane 전환당 풀 프레임을 없앤다.
- **서버 변경**: ① ANSI 분기에도 `compress_server_message`를 적용(대칭화, 소규모 — **M0에 끼울 만큼 작다**)
  ② `BlitEncoder`가 동일 스타일 런을 합치게(더 큰 작업, M6).

### B8. JSON API는 요청 1개 = 연결 1개

`handle_connection`은 `read_initial_request_line`으로 **한 줄만 읽고** 처리 후 리턴한다 — 루프가 없다
(`src/api/server.rs:139-152` `[v]`). 브리지 위에서는 **JSON 호출 1개 = ssh exec 1개 = 원격 herdr 프로세스
1개**다. 앱의 리스트 새로고침 한 번이 exec 여러 개가 된다.
→ NDJSON 요청 루프로 바꾸고 `id`로 상관시킨다. 스트리밍 arm은 지금처럼 연결을 점유. 서버 ~50줄,
앱의 ssh 채널 수가 O(N) → O(1).

### B9. `events.subscribe`에 시퀀스가 없고 매번 링을 전량 리플레이

봉투가 `{event, data}`뿐이라 갭 검출이 불가능하고, 일반 구독은 링버퍼를 통째로 재생하며, 폴 루프가
구독당 초당 몇 건으로 상한을 건다 `[i]`. 모바일은 재연결이 상시라 매 포그라운드마다 과거를 먹으면서
라이브에 도달하지 못한다.
→ 봉투에 `sequence`, 구독 파라미터에 `since` / `from_now`, 축출 시 `gap` 마커, 틱마다 전량 드레인.
**해소 전까지 v1은 구독 대신 `agent.list` 폴링(포그라운드 3–5초)으로 간다.**

### B10. `pane.read`는 변경 검출에 못 쓴다 (+ idle 에이전트 pane은 스크롤된다)

> 2026-08-22 정정: 이전 판의 `[i]`를 직접 열어 확인한 결과, **결론은 유지되지만 근거와 범위가 달랐다.**
> 금지 범위가 근거보다 넓었다 — 아래가 실제로 확인된 것이다.

- **변경 검출 불가 (확정)**: `PaneReadResult.revision`이 생성 지점마다 하드코딩 `0`이다
  (`src/app/api/panes.rs:1202` · `src/api/server.rs:1231` · `src/server/headless.rs:5958` `[v]`).
  두 번 읽어 revision을 비교하는 폴링은 **원리적으로 불가능하다.**
- **스크롤 부작용 (범위 확정)**: `PaneReadParams.intent`는 `#[serde(skip)]`이고
  (`src/api/schema/panes.rs:261-263` `[v]`), `ReadIntent`의 기본값이 `Interactive`이므로
  (`src/api/schema/common.rs:70-74` `[v]`), 와이어 `pane.read`는 **항상 Interactive**로 들어가
  alt-screen 스크롤 캡처 분기를 탄다 (`src/server/headless.rs:3164` `[v]`).
  단 `alt_screen_read_spec`의 가드가 좁다 (`src/server/headless.rs:3172-3199` `[v]`) — **전부** 만족해야 발동한다:
  `format=Text` · `source=Recent|RecentUnwrapped` · attach 소유자 없음 · 대기 중 read 없음 ·
  에이전트가 인식됨 · **`state == AgentState::Idle`**.
- **따라서 "`pane.read` 반복 호출 금지"는 과대했다.** 단 **상태 이름으로 안전을 선언하면 안 된다**
  (2026-08-22 외부 리뷰 지적, 확인함): 가드는 `terminal.state`를 **서버가 요청을 평가하는 그 순간** 읽는다
  (`src/server/headless.rs:3191-3199` `[v]`). 클라이언트가 `agent.list`에서 `Blocked`를 본 뒤 read가 서버에
  닿기 전에 `Idle`로 바뀌면 **스크롤 분기는 그대로 발동한다.** 즉 "blocked pane 읽기는 안전"이 아니라
  **"평가 시점에 Blocked이면 분기를 건너뛴다"**일 뿐이고, previously-blocked pane은 안전하지 않다.
- **따라서 v1 계약**: `intent`가 와이어에 노출되기(또는 기본값이 `Passive`가 되기) 전까지,
  **살아있는 pane에 `format=Text` + `source=Recent|RecentUnwrapped` 조합을 보내지 않는다.**
  단발 스냅샷이 필요하면 그 서버 픽스(5줄)를 **선행**시켜라.
- **그래도 결론은 그대로**: pane 화면은 observe 스트림으로 간다. 다만 **진짜 이유는 스크롤이 아니라
  `revision:0`**이다 — `pane.read`로는 무엇이 언제 바뀌었는지 알 수 없다. `pane.read`는 **단발 스냅샷 용도로만** 쓴다.
- **서버 픽스(선택)**: `intent`를 와이어에 노출하거나 기본값을 `Passive`로(5줄). M6 이전에는 불필요.

### B6. pane 전환마다 재연결 — 타깃은 연결 1회당 1개

`ObserveTerminal`(`wire.rs:471`) / `ControlTerminal`(`:477`) / `AttachTerminal`(`:419`)는 있지만
**`RetargetTerminal`은 없다** `[v]`. 앱의 핵심 동작이 pane 스와이프 전환인데 매 전환마다 채널 스폰 +
핸드셰이크 + 풀 프레임 베이스라인을 다시 낸다.
→ `RetargetTerminal { target }`를 enum **꼬리에** 추가. 핸들러는 타깃 재해석 + `client.mode` 교체 +
`render_state.reset_baseline()`. observe→observe만 지원하면 소유권 처리가 필요 없어 ~40줄.
없으면 pane당 채널 프리페치로 우회한다(sshd 부하가 대가).

### B11. 인증 = ssh 키 = 셸 전체 권한

와이어에도 JSON 소켓에도 auth 필드가 없다 — 통제는 0600 소켓뿐 `[v]`(`api/server.rs`는 핸드셰이크 없이
바로 요청을 읽는다). 폰을 잃어버리면 그 키로 머신 셸이 열린다.
→ 실용해는 **서버 변경 0**: 앱 전용 키를 `authorized_keys`에
`command="…",no-pty,no-port-forwarding`으로 제한한다. 브리지가 둘이므로 키 2개 또는
`SSH_ORIGINAL_COMMAND` 디스패치 래퍼 1개. herdr에 페어링 토큰을 넣는 건 v1 범위 밖([`06-open-decisions.md`](./06-open-decisions.md) 결정 4).

### B12. Windows 서버

`run_terminal_attach`가 Windows에서 `Unsupported` `[v]`. observe 서버 핸들러 자체에 cfg 게이트가
있는지는 미확인 `[추정]`. **v1은 Unix 서버로 스코프를 명시한다.**

---
