# 04 — 마일스톤

각 단계가 **단독으로 쓸모 있게** 끊었다. M0는 앱 코드 0줄이며 앱과 무관하게 #70을 닫는다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

### M-1 — 지반 동기화 (M0 선행, 앱 코드 0줄) — **2026-08-22 신설**
`update-upstream`으로 upstream/master **148커밋** 반영 + **#68**(기본 브랜치 `mx`에 push CI, 한 줄 diff)을 한 배치로.

**왜 M0보다 먼저인가**: upstream 머지는 앱이 의존하는 태그를 **실제로 민다** —
`ServerMessage::Terminal` 13→2, `ClientLaunchMode::TerminalAttach` 1→2 ([`03-blockers.md`](./03-blockers.md) B1 표 `[v]`).
동기화 **전에** 태그를 동결하고 픽스처를 뜨면, 그것들은 머지 시점에 반드시 빨개진다. 그리고 148커밋 충돌을 푸는
사람은 그 빨강을 "머지 때문"으로 읽고 픽스처를 재생성한다 — **B2가 막으려던 바로 그 세탁이 제도화된다.**
되돌리기 비용이 비대칭이다: 동기화 먼저 = M0가 사이클 1회 밀림(**가역**). M0 먼저 = 빨간 테스트 아래에서
머지 + 픽스처 재생성(**비가역** — 그 재생성이 옳았는지 사후에 증명할 방법이 없다).

**됐다** = 머지 완료 · `mx` push가 clippy/nextest를 탄다 · 머지 후 태그 순서가 확정됐다
(fork variant를 enum 꼬리에 재배치하는 기존 관행이 있다 — `wire.rs` 인근 주석 `[i]`).

### M0 — 레이아웃 식별 + 호환 창 + 동결 + 픽스처 (herdr-mx 쪽, 앱 코드 0줄)

- **M0-a 레이아웃 지문 (신규 · 최우선).** `ClientMessage`/`ServerMessage` 태그 테이블의 해시를 `Welcome`에
  싣고 클라이언트가 **완전일치** 검사. **이유**: `PROTOCOL_VERSION`은 이미 레이아웃 식별자로서 죽었다 —
  mx와 upstream이 둘 다 `20`인데 태그가 다르다([`03-blockers.md`](./03-blockers.md) B1 `[v]`).
  지문 없이 창만 넓히면 **하드 리젝(시끄러움)이 오파싱(조용함)으로 바뀐다.**
- **M0-b 호환 창.** `MIN_SUPPORTED_PROTOCOL..=PROTOCOL_VERSION` (#70 옵션 1만). **M0-a 위에서만 의미를 갖는다.**
- **M0-c `ServerMessage` 태그 동결 테스트.** `client_message_wire_tags_preserve_protocol_15_order`
  (`src/protocol/wire.rs:1383` `[v]`)의 미러, 약 30줄.
- **M0-d 와이어 픽스처 코퍼스 + 최신성 CI 잡.** (조사 문서의 B3가 여기로 흡수됐다.)

**구현 위치 = fork.** M0-a는 정의상 upstream이 가질 이유가 없고(fork의 태그 테이블을 아는 건 fork뿐),
upstream은 18일에 148커밋이라 수용 리드타임이 통제 밖이다 — **통제 밖 의존성을 임계 경로에 두지 않는다.**
M0-b만 머지 이후 additive 분리 PR로 upstream에 제안한다(임계 경로 밖, 거절 시 손실 0).

**단독 가치**: #70이 원래 호소하던 "리모트 N대가 클라 업그레이드 한 번에 전멸"이 앱과 무관하게 해소된다.
**됐다** = 태그 테이블이 바뀌면 CI red · 서버 v20에 v19 클라이언트가 붙어 정상 렌더 · 게이트 green · 픽스처 커밋.

### M1 — `packages/herdr-client-ts` (헤드리스 코어, 폰 없음)
ssh 어댑터 인터페이스(노드=`ssh2`, RN=네이티브 모듈) · JSON API 클라이언트(요청 1개=채널 1개 계약 캡슐화) ·
최소 와이어 코덱(envelope / `Hello` 인코드 / `Welcome`·`Terminal`·`ServerShutdown`·`Pong` 디코드) ·
observe 세션 상태기계.
**단독 가치**: CLI로도 쓸 수 있는 TS SDK — herdr을 스크립트로 조종하는 다른 도구의 기반.
**됐다** = 노드에서 실서버 대상으로 ① 세션 스냅샷 파싱 ② `agent.list` 파싱 ③ observe로 `Terminal`
프레임 100개 수신, **그 동안 해당 pane 크기가 불변임을 `pane.get`으로 확인** ④ 픽스처 코퍼스 테스트 green.

### M2 — 읽기 전용 앱 v1
리모트 목록 / Agents 홈 / 워크스페이스–탭–pane 브라우저 / **pane 뷰어(observe + TerminalAnsi + xterm WebView)**.
쓰기 없음, 폴링 기반(B9 우회). 설정·연결로그·트러블슈팅.
**단독 가치**: "폰에서 에이전트 상태를 보고 화면을 읽는다"가 성립 — 목적의 절반.
**됐다** = 실기기+실서버로 (a) blocked를 Agents 홈에서 60초 내 발견 (b) 해당 pane 화면을 읽을 수 있음
(c) **30분 시청 동안 데스크톱 레이아웃 무변화** (d) 백그라운드 왕복 10회에 강제종료 0
(e) **폰보다 넓은 pane(예: 200컬럼)에서 커서와 최신 출력이 화면에 보인다** — [`03-blockers.md`](./03-blockers.md) B4 완화가 실제로 동작함.

### M3 — 입력 (와이어 쓰기 없이)
소프트 키보드 → `pane.send_input{text}` · 액세서리 키 행(Enter/Esc/Ctrl-C/화살표/Tab) → `keys[]` ·
퀵 커맨드(y/n/승인).
**단독 가치**: "폰에서 승인 눌러주기" 완성 — 목적의 나머지 절반.
**됐다** = 폰에서 승인 프롬프트에 y → observe 스트림에 반영 확인. 그 동안 PTY 크기 불변.

### M4 — transport 생존성 ([`05-orca-transport.md`](./05-orca-transport.md) 전부)
**됐다** = 기내모드 토글 ×10 / Wi-Fi↔셀룰러 전환 ×10 / 30분 백그라운드 후 복귀 — 전부 수동 개입 없이
자동 복구. **강제종료로만 낫는 상태 0건.**

### M5 — 푸시 (blocked 한정)
herdr 플러그인 1개 — `pane.agent_status_changed`(`src/api/schema/events.rs:75, 222, 253` `[v]`)에 훅을 걸고,
`HERDR_PLUGIN_EVENT_JSON`을 읽어 **네트워크를 치지 않고** 큐 파일에 append만 한다. 드레인은 별도
launchd/systemd 센더가. 훅 런타임에 타임아웃·재시도·DLQ가 없기 때문 `[i]`.
훅은 `event_hub.push`보다 **먼저** 실행되므로(`src/app/api.rs:782-784` `[v]`) 링 축출·드레인 상한(B9)을
구조적으로 우회한다. 등록은 `herdr plugin link`, **서버 재시작 불필요** `[i]`.
**제약**: `Done`은 전역 `seen` 비트라 데스크톱이 그 탭을 보면 사라진다 `[i]` →
**디바이스 독립적인 건 `blocked`뿐.** v1 푸시는 blocked만.
**됐다** = 데스크톱을 안 보고 있을 때 blocked 발생 → 폰 알림 → 탭 → 해당 pane 도달, 5회 연속.

### M6 — 제어·스크롤·리타겟 (서버 변경 동반)
B6 + 스크롤백 + observe 뷰포트. 입력 순간에만 `ControlTerminal`로 임시 승격하고 즉시 복귀하는 계약
(백그라운드 진입 시 항상 detach, 복귀 시 항상 takeover).
**됐다** = pane 스와이프 전환이 재연결 없이 <200ms · 스크롤백 열람 · 제어 해제 시 데스크톱 크기 자동 복원.

---
