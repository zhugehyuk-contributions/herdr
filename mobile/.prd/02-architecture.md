# herdr mobile — Architecture

앱은 herdr 서버를 **두 채널**로 본다: 제어·열거·입력은 JSON socket API, pane 화면은 클라이언트
와이어 프로토콜. 둘 다 ssh exec 위 stdio 릴레이라 서버에 새 리스너를 열지 않는다.

이 문서의 핵심 결정은 **읽기를 `ObserveTerminal` + `RenderEncoding::TerminalAnsi`로 하고
쓰기를 JSON API로 분리**하는 것이다. 그 결과 bincode 셀 코덱 포팅이 대부분 사라지고,
폰이 데스크톱의 PTY를 리사이즈하지 않는다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

### 2.1 두 채널

|  | 컨트롤 플레인 | 데이터 플레인 |
|---|---|---|
| 브리지 | `herdr remote-api-bridge` | `herdr remote-client-bridge` |
| 포맷 | NDJSON `{id, method, params}` | `[u32 LE len][bincode payload]` |
| 담당 | 열거 · 내비게이션 · 에이전트 · **입력** · 이벤트 | pane 화면 스트림 1개 |
| 수명 | **요청 1개 = 연결 1개** ([`03-blockers.md`](./03-blockers.md) B8) / 스트리밍만 상주 | 연결 1개 = pane 1개, 상주 |

브리지 이름은 `src/remote/unix.rs:75-76` `[v]`. 둘 다 unix 소켓 ↔ stdio 순수 바이트 펌프라
**서버에 새 리스너를 열 필요가 없고**, 동시에 **인증 경계가 전적으로 ssh**라는 뜻이다.

### 2.2 핵심 결정 — 읽기는 `ObserveTerminal` + `TerminalAnsi`

인코딩 분기는 **연결 모드와 직교**한다. 그리고 그 직교성은 우연이 아니라 코드 구조다 —
`TerminalAttach`와 `TerminalObserve`가 **같은 match arm을 공유**하며 둘 다
`render_terminal_virtual(runtime, area)`로 동일한 `FrameData`를 만들고
(`src/server/headless.rs:4152-4153` `[v]`), 그 뒤 `client.render_state.prepare_frame(frame)`이
**모드와 무관하게 한 번** 호출된다(`:4237` `[v]`). 인코딩 분기는 그 `prepare_frame` 안에 있다
(`src/server/render_stream.rs:105-123` `[v]`).
→ **observe 클라이언트는 attach와 바이트 동일한 프레임을 받으며**, `RenderEncoding::TerminalAnsi`를
요청하면 서버는 `BlitEncoder`로 **이미 diff된 ANSI 바이트**를 담은
`ServerMessage::Terminal(TerminalFrame{seq,width,height,full,bytes})`를 보낸다
(`src/server/render_stream.rs:114` `[v]`). **kitty 그래픽은 그 바이트 안에 인라인된다**
(`render_stream.rs:109` `insert_graphics_before_sync_end` `[v]`).

프로덕션 `herdr attach`가 이미 이 인코딩을 쓴다 — `run_terminal_attach`가
`RenderEncoding::TerminalAnsi`를 넘긴다 (`src/client/mod.rs:2548` `[v]`).

> **2026-08-22 리시트 — 이 절 전체가 실측으로 확인됐다.** `tests/observe_terminal_ansi.rs`의
> `observe_terminal_streams_ansi_bytes_without_resizing_pane`이 격리 서버를 띄워 `TerminalAnsi`로 핸드셰이크하고
> `ObserveTerminal`을 보낸 뒤 **실제 ANSI 바이트를 받는다** —
> `TerminalFrame{seq:1,width:100,height:30,full:true,bytes:55925}`, 선두가 `ESC[?2026h ESC[?25l … ESC[2J ESC[1;1H`.
> **동시에 pane PTY 크기가 불변**임도 확인(23×53 → 23×53). 인코딩을 `SemanticFrame`으로 바꾸면 테스트가
> 실패하므로(변이 검사) 진짜로 이 분기를 구별한다. 게이트: nextest PASS(재실행 확인), clippy 무경고.
> **이전 판에서 "유일한 미검증 축"이었던 것이 닫혔다.** 부산물로 [`03-blockers.md`](./03-blockers.md) B13(대역폭)이 드러났다.

```
Hello{ v20, cols, rows, cell_px, TerminalAnsi, …, launch=TerminalAttach }
  → Welcome{ version, error? }
  → ObserveTerminal{ target: "w1:p3" }          # wire.rs:471 [v]
  → Terminal(TerminalFrame{ …, bytes })  …스트림
  → xterm.js WebView.write(bytes)
```

**결과: 앱이 손으로 쓸 bincode 디코더는 envelope + `Welcome` + `Terminal` 3개뿐이다.**

> **`Welcome`은 3필드다** — `version: u32` · **`encoding: RenderEncoding`** · `error: Option<String>` (`src/protocol/wire.rs` `[v]`).
> 그중 **두 번째**가 앱에 중요하다: 서버가 **실제로 선택한 인코딩**을 돌려준다. 요청한 `TerminalAnsi`가 승인되지
> 않았는데 그대로 진행하면 앱은 semantic `Frame`을 `Terminal`로 오독한다 →
> **클라이언트는 `Welcome.encoding`을 반드시 검사하고 불일치 시 하드 실패해야 한다.**
> `Hello`의 필드명이 `requested_encoding`인 것이 이미 그 뜻이다 — *요청*이지 확정이 아니다.
> (기존 Rust 하네스 `tests/support/mod.rs`의 `decode_welcome`은 이 필드를 소비하지만 버린다. 그 함수의
> doc 주석이 "Welcome { version, error }"라고 적은 것은 **낡았다** — 코드는 3필드를 올바르게 읽는다.)
`CellData`(`wire.rs:582` `FrameData`의 셀 배열 `[v]`) · `FrameDelta` · FNV-1a 체크섬 · raw deflate ·
델타 재구성이 전부 빠진다. 레포 안에 코덱 참조 구현이 있다 — `tests/server_headless.rs:154-250`이
프레이밍과 bincode varint를 평문으로 손구현해 둔 것 `[v]`.

> **프레임 크기 상한은 값이 아니라 규칙이다 (2026-08-22 확인 — 앱이 틀리기 쉬운 곳).**
> 서버는 프레임마다 고른다 — 그래픽이 없으면 `MAX_FRAME_SIZE` 2 MiB, 있으면 `MAX_GRAPHICS_FRAME_SIZE`
> **32 MiB** (`src/server/headless.rs:4231-4235` · `wire.rs:27,32` `[v]`). 프로덕션 클라이언트가 같은 규칙을
> 미러하고 그 함수의 주석이 위험을 명시한다 — *"every reader must use the larger cap when kitty graphics are
> enabled — otherwise a large graphics frame fails framing and flaps the connection"* (`src/client/mod.rs:6483-6491` `[v]`).
> **그리고 이 경로엔 그래픽이 온다**: kitty 그래픽은 별도 메시지가 아니라 위에서 본 대로 **ANSI 바이트 안에
> 인라인**된다. → 앱이 2 MiB(또는 임의의 중간값)를 하드코딩하면 **합법 프레임을 거절하고 연결이 플랩한다.**

대가는 xterm 종속이다. 앱이 셀을 자기 UI로 재해석할 수 없다([`06-open-decisions.md`](./06-open-decisions.md) 결정 1).

## Tensions — 이 계획의 읽기 경로는 레포의 명시 가이드레일과 충돌한다

> **2026-08-22 발견.** 이 레포에 `CLAUDE.md`(→ `AGENTS.md`, 20KB)가 있고 그 **Universal Project Rules**에
> **Runtime/client boundary guardrail**이 있다. 이 계획은 그걸 읽지 않은 채 §2.2를 결정했다.

**가이드레일 원문** (`AGENTS.md` §Universal Project Rules):
> *"Herdr is migrating toward a server-owned runtime protocol with the TUI as one client.
> New work should not deepen the current server/TUI coupling."*
> *"**Do not add new shared behavior that only works through the private TUI client socket.**"*
> *"Pane/agent metadata, process state, **terminal state**, events: server/runtime."*

**적용 범위에 예외 없음**: `AGENTS.md:11` — *"Universal project rules apply to every agent working on
Herdr, **including forks**."* (`:243`의 "private or custom fork" 예외는 이슈/PR/푸시 **워크플로**에 대한
것이지 Universal Rules가 아니다.)

**충돌 내용**: §2.2가 고른 읽기 경로(`ObserveTerminal` + `TerminalAnsi` on `remote-client-bridge`)는
**사설 TUI 클라이언트 소켓**이다. 새 클라이언트(모바일 앱)의 **터미널 상태 전달 전체**를 거기 얹는 것은
가이드레일이 금지한 "사설 TUI 소켓으로만 동작하는 새 공유 동작"에 정확히 해당한다.

**비용 (가설이 아니라 이미 관측된 것)**: 이 계획이 이미 기록한 세 가지가 전부 "사설 채널에 올라탄 대가"의
증상이다 — ①**B1** 포크 간 태그 스큐(같은 `PROTOCOL_VERSION=20`, `Terminal` 13 vs 2)는 JSON API가 아니라
**와이어**에서 갈렸다 ②**B13** `Terminal`만 deflate를 못 받는다(압축이 semantic 분기에만 걸려 있다)
③범프 빈도 실측 7.2일이 전부 **와이어** 이야기다. JSON API는 그동안 스키마 아티팩트로 CI 강제되며 안정적이었다.
→ upstream이 JSON API를 유지한 채 사설 소켓을 바꾸면 **제어는 되는데 화면만 죽는다.**

**그런데 지금 중립 경로가 없다 — 이것도 이 계획이 실측했다**:
- `pane.read`는 변경 검출 불가(`revision`이 전 생성 지점 하드코딩 0) + idle 에이전트 pane 스크롤 부작용 → **B10**
- `events.subscribe`는 시퀀스가 없고 매번 링을 전량 리플레이 → **B9**
- JSON API에 **터미널 화면을 스트리밍하는 메서드 자체가 없다**
가이드레일의 문구가 *"exposed through the JSON API/event path **when practical**"*이므로, 현재로선 중립 경로가
practical하지 않다는 사실 자체는 방어가 된다.

**따라서 정직한 위치**: §2.2는 **의도적이고 문서화된 이탈**이지 무지가 아니다 — 단, 이 계획은 지금까지
**그 사실을 적지 않았다.** 조용히 넘기지 않기 위해 여기 남긴다. 정합적인 장기 답은 **B8·B9·B10을 닫아
JSON API/이벤트 경로가 터미널 프레임을 나를 수 있게 만드는 것**이고, 그 셋은 이미 이 계획의 블로커 목록에 있다.
즉 **가이드레일과 이 계획의 백로그는 같은 방향을 가리킨다.** 차이는 순서뿐이다.

→ **오너 결정 필요 (D8)**: (a) 이탈을 수용하고 M2를 와이어로 진행하되 B8/B9/B10을 "정합성 부채"로 명시 ·
(b) 중립 경로 확장(서버에 스트리밍 터미널 API 추가)을 M2 **앞에** 놓는다 · (c) upstream에 가이드레일 해석을
질의한다. **(a)가 기본값이나, 이건 내가 조용히 고를 결정이 아니다.**

### 2.3 쓰기는 JSON API — 와이어로 쓰지 않는다

`ControlTerminal` / `AttachTerminal`은 공유 PTY를 **폰 그리드로 리사이즈하고 락을 건다**
(`src/server/headless.rs:2665-2675` `[v]`). 데스크톱 파괴다.

반면 `observe_terminal_client`는 `(cols, rows)`를 **로그 문자열에만 쓰고** 리사이즈도 락도 하지 않는다
(`src/server/headless.rs:1763-1786` `[v]`; 바로 아래 `control_terminal_client`(`:1789`)와 대조).
대신 입력을 조용히 버린다 — 모드가 `TerminalObserve`면 `return false`
(`src/server/headless.rs:2882-2886` `[v]`).

→ **읽기는 observe 와이어, 쓰기는 `pane.send_input{pane_id, text?, keys[]}`**
(`src/api/schema/panes.rs:243` `PaneSendInputParams` `[v]`). attach와 무관한 일반 메서드다.
소프트 키보드의 IME 텍스트는 `text`로, Enter/Ctrl-C/화살표는 `keys[]`로.

**이 분리 하나로 세 블로커가 동시에 사라진다** — 그리드 락 · takeover 경쟁 · stale attach 미회수.
남는 것은 스크롤백(observe는 `AttachScroll` 불가 `[i]`)과 마우스 리포팅이고, M6로 미룬다.

### 2.4 ssh 계층 — orca 대비 최대 신규 작업

orca는 WebSocket이라 RN 기본 기능으로 끝났다. herdr은 ssh exec 채널이 필요하고 RN에 표준 ssh 스택이
없으므로 **네이티브 모듈 1개**(iOS: libssh2/NMSSH, Android: sshj)를 직접 싸야 한다. 계약:

- 호스트당 transport 1개 + **채널 N개.** 새 TCP 다이얼 금지 — herdr 데스크톱도 같은 이유로
  `ControlMaster=auto` / `ControlPersist`를 주입한다 `[i]`.
- 상주 채널 2개: `remote-client-bridge`(보고 있는 pane) + `remote-api-bridge`에 핀 고정한 스트리밍 구독.
- 단발 채널: JSON API 호출 1개당 1개 ([`03-blockers.md`](./03-blockers.md) B8이 해소되기 전까지).
- ssh keepalive만으로는 검출까지 ~60초라 앱 레벨 워치독([`05-orca-transport.md`](./05-orca-transport.md) L1)을 위에 얹는다.

### 2.5 앱 스택 — orca 와꾸를 최대한 그대로

[`01-spec.md`](./01-spec.md) 전제 2에 따라 **기본값은 "orca와 같게"**다. 스택은 Expo bare + RN +
expo-router + TS, pnpm, vitest. 터미널 엔진은 xterm을 WebView용으로 번들. 위치는 이 폴더(`mobile/`).
공용 TS 코어는 `packages/herdr-client-ts` 워크스페이스 패키지로 두고 Metro `watchFolders`에 추가한다.

이식은 **copy / adapt / rewrite 3등급**으로 나눈다 — "transport 계층을 통째로 복사한다"는 표현은
같은 문서가 적어둔 WebSocket→ssh 차이와 모순되므로 쓰지 않는다(2026-08-22 외부 리뷰 지적).

| 등급 | 대상 | 비고 |
|---|---|---|
| **copy** | 프로젝트 스캐폴딩 · expo-router 라우트 트리 · 화면 골격(master-detail) · 설정/연결로그/트러블슈팅 화면 · xterm WebView 브리지와 스크롤백 설정 | UI 셸은 전송과 무관 |
| **port** (로직·테스트는 그대로, I/O만 갈아끼움) | 재연결 **상태기계**와 정책 — [`05-orca-transport.md`](./05-orca-transport.md) L1~L7 · X1~X6의 **판단 규칙**과 그 테스트 | 백오프·워치독·single-flight·구독 replay는 전송 무관 |
| **rewrite** | ssh I/O 어댑터 전체 · 생존성 **신호** 판정(`readyState` → "자식 살아있고 파이프 열렸는데 바이트가 안 옴", close code → exit status/stderr) · 오류 모델 | §2.4의 네이티브 모듈이 여기 |

**덜어낸다**: 페어링 · E2EE · 릴레이(ssh가 대체) · `git.*`/`files.*`/tasks 화면(herdr JSON API에 대응 메서드 없음).

**새로 짠다 (orca에 등가물이 없다)**: ssh 네이티브 모듈(§2.4 — 최대 신규 작업) ·
herdr 와이어 코덱 3종(§2.2 — **✅ 2026-08-22 완료**, `packages/herdr-client-ts`) ·
**읽기 뷰포트 UX**(아래 참조).

> **2026-08-22 정정 2건** (근거 = [`08-orca-port-map.md`](./08-orca-port-map.md), orca 실물 대조):
> - **pane(split) 레벨은 신규 설계가 아니다.** orca에 layout leaf가 있고 모바일이 그걸 받는다
>   (`src/shared/agent-status-types.ts:107` `[v]`). **이식 대상으로 내린다.**
> - **§2.5에 없던 drop이 있다**: `mobile/src/session/mobile-terminal-viewport-resubscribe.ts`(293줄 + 테스트 333줄)는
>   통째로 **데스크톱 PTY를 폰 뷰포트에 맞춰 재구독하는 수렴 루프**다. herdr은 observe라 리사이즈하지 않으므로(§2.3)
>   **전량 drop**. 동시에 이것은 **B4(읽기 뷰포트 UX)에 orca 선례가 없다**는 뜻이다 —
>   "화면 레이아웃을 최대한 가져온다"가 **읽기 뷰포트만은 성립하지 않는다.** 그 부분은 우리가 설계해야 한다.
>
> **이식의 최대 위험**: orca `mobile/` 파일 **293개가 데스크톱 레포 루트의 `src/shared/`를 import**한다
> (`mobile/metro.config.js:9,14-15`의 watchFolders). copy 등급 파일도 그냥 복사하면 컴파일되지 않는다.
> 다행히 밀도가 착수 순서와 반비례한다 — 먼저 가져올 `terminal/`은 **10/107**, `session/`은 **115/310**.

> **재사용률을 숫자로 주장하지 않는다.** UI 셸·라우트·xterm·정책은 재사용되지만 **임계 경로(ssh 어댑터 ·
> 오류 모델 · herdr 코덱 · pane 모델)는 신규**다. 전제 2는 달성 가능한 목표이되, 일정 착시를 만들지 않으려면
> 계약을 "transport 전체 코드 포팅"이 아니라 **"상태기계·테스트는 포팅, I/O 어댑터는 재작성"**으로 읽어야 한다.

---
