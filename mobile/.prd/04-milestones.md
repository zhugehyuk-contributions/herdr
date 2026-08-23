# 04 — 마일스톤

> **먼저 [`00-driver.md`](./00-driver.md)를 읽어라** — 현재 어느 마일스톤에 있고 다음 행동이 무엇인지는 거기 있다.
> 이 파일은 각 마일스톤이 **무엇이며 무엇으로 닫히는가**의 정의다.

## 완료의 정의가 바뀌었다 (2026-08-23)

아래 마일스톤들은 원래 **herdr-mx 쪽 코드와 앱 코드** 기준으로 쓰였다. 유저 목표가 확정되면서
각 마일스톤은 이제 **플랫폼별로 닫힌다**:

```
Mn 코드 완료  →  Mn Android QA PASS  →  Mn iOS QA PASS  →  Mn 닫힘
                 (별도 에이전트 판정)     (별도 에이전트 판정)
```

- **QA 판정은 반드시 별도 에이전트가** 내린다 ([`10-mobile-qa.md`](./10-mobile-qa.md) §자기 인증 금지).
  구현자도 디스패처도 자기 작업을 통과시킬 수 없다.
- 아래 각 마일스톤의 **"됐다"는 그 QA의 시나리오 목록**으로 읽는다. QA 에이전트가 실행할 대본이다.
- M-1·M0·M1은 앱 코드 0줄(herdr-mx 쪽 / 헤드리스 TS)이라 이 게이트가 적용되지 않는다.

## iOS 트랙

iOS는 별도 마일스톤이 아니라 **M2~M6 각각의 두 번째 플랫폼**이다. 순서·수용 기준은 Android와 동일하다.

**선행 조건 하나가 유저 게이트다**: `Xcode` 설치. 2026-08-23 실측 — `xcode-select -p`가
`/Library/Developer/CommandLineTools`, `/Applications/Xcode.app` 없음, 시뮬레이터 0개, `mobile/ios/` 없음.
빌드는 EAS 클라우드로 우회 가능하나 **QA에는 시뮬레이터/실기기가 필요**하고 시뮬레이터는 Xcode에 딸려온다.
설치되면 [`06-open-decisions.md`](./06-open-decisions.md) 결정 7(Citadel + `Wellz26/swift-nio-ssh` 정확 핀)을
**첫 빌드 전에** 확정한다 — 그날 비용이 무한이고 오늘 비용이 0인 종류다.

---

각 단계가 **단독으로 쓸모 있게** 끊었다. M-1과 M0는 앱 코드 0줄이며 앱과 무관하게 **#70이 제기한 문제를 해소한다**
(#70을 *닫는다*고는 쓰지 않는다 — 이슈 본문의 acceptance가 M0-a~e와 일치한다는 증거가 없다. 닫으려면 이슈 본문을 새 acceptance로 갱신하는 게 먼저다).

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

### M-1 — 지반 동기화 (M0 선행, 앱 코드 0줄) — **2026-08-22 신설**
`update-upstream`으로 upstream **`v0.8.2`** 반영 + **#68**(기본 브랜치 `mx`에 push CI, 한 줄 diff)을 한 배치로.
머지 단위는 브랜치 HEAD가 아니라 **최신 릴리즈 태그**다(스킬 규약). 실측: `v0.8.0..v0.8.2` = **133커밋**,
`merge-tree` 충돌 **27개 파일**(`wire.rs`·`headless.rs`·`client/mod.rs`·`main.rs` 포함) `[v]`.
`DIVERGENCE.md`는 "currently tracking: upstream v0.8.0"이므로 **정확히 한 릴리즈 밀렸다.**

> **충돌 해소 규칙 (스킬 규약, 이 계획의 전제이기도 하다)**: upstream이 **중간 삽입한 enum variant는 tail로
> 이동**하고 **기존 wire tag를 불변으로 유지**한다.
> **이 규칙은 레포 코드 안에 전례와 함께 이미 문서화돼 있다** — `src/protocol/wire.rs:469-470` `[v]`:
> *"Appended after the mx variants so their bincode wire tags stay stable across the upstream v0.7.4 merge."*
> 즉 `ObserveTerminal`(태그 12) 자신이 지난 머지에서 그 규칙으로 배치된 산물이다. upstream 바이너리와의 wire 호환은 **비목표**(fork 피어끼리만 통신).
> → **mx의 태그는 머지를 넘어 보존되므로 M1의 TS 코덱을 지금 써도 머지 후 유효하다.** 이것이 R3 하에서
> M1을 병렬 착수할 수 있는 근거다([`06-open-decisions.md`](./06-open-decisions.md) §M-1 실측).

**왜 M0보다 먼저인가**: upstream 머지는 앱이 의존하는 태그를 **실제로 민다** —
`ServerMessage::Terminal` 13→2, `ClientLaunchMode::TerminalAttach` 1→2 ([`03-blockers.md`](./03-blockers.md) B1 표 `[v]`).
동기화 **전에** 태그를 동결하고 픽스처를 뜨면, 그것들은 머지 시점에 반드시 빨개진다. 그리고 148커밋 충돌을 푸는
사람은 그 빨강을 "머지 때문"으로 읽고 픽스처를 재생성한다 — **B2가 막으려던 바로 그 세탁이 제도화된다.**
되돌리기 비용이 비대칭이다: 동기화 먼저 = M0가 사이클 1회 밀림(**가역**). M0 먼저 = 빨간 테스트 아래에서
머지 + 픽스처 재생성(**비가역** — 그 재생성이 옳았는지 사후에 증명할 방법이 없다).

**됐다** = 머지 완료 · `mx` push가 clippy/nextest를 탄다 · **이번 동기화의 기준선이 확정됐다**
(fork variant를 enum 꼬리에 재배치하는 기존 관행이 있다 — `wire.rs` 인근 주석 `[i]`).
**"태그 순서가 영구 확정됐다"가 아니다** — 다음 동기화에서 또 움직인다. 그래서 M0에 반복 정책이 필요하다(아래).

### M0 — 레이아웃 식별 + 호환 창 + 동결 + 픽스처 (herdr-mx 쪽, 앱 코드 0줄)

- **M0-a 와이어 ABI 게이트 (신규 · 최우선).** **bincode `Hello`보다 먼저 읽는 고정 prelude**에
  `fork namespace + WIRE_ABI_EPOCH`를 싣고, 양쪽이 그것부터 대조한다.
  **이유**: `PROTOCOL_VERSION`은 이미 레이아웃 식별자로서 죽었다 — mx와 upstream이 둘 다 `20`인데 태그가
  다르다([`03-blockers.md`](./03-blockers.md) B1 `[v]`). 지문 없이 창만 넓히면 **하드 리젝(시끄러움)이
  오파싱(조용함)으로 바뀐다.**
  - **왜 `Welcome`이 아니라 prelude인가 (2026-08-22 외부 리뷰 지적, 확인함).** 첫 번째로 갈라지는 값인
    `ClientLaunchMode::TerminalAttach`(mx 1 / upstream 2)는 **`Hello`의 필드**이고 `Hello`를 디코드하는 것은
    **서버**다. 지문을 서버 응답인 `Welcome`에 두면 **서버가 이미 `Hello`를 오파싱한 뒤에** 검사하게 된다.
    게이트는 어떤 bincode 디코딩보다도 앞에 있어야 한다.
  - **해시 범위도 태그로는 부족하다.** upstream은 `MouseCapture`에 `sgr_pixels` **필드를 추가**했다 `[v]` —
    태그는 그대로인데 payload 레이아웃이 바뀐다. 따라서 대상은 최상위 두 enum의 태그가 아니라
    **중첩 enum(`ClientLaunchMode`·`RenderEncoding`)과 payload 구조체 필드 순서·타입까지 포함한
    transitively complete schema fingerprint**이거나, 그것을 대신하는 수동 관리 `WIRE_ABI_EPOCH`다.
    (빌드 ID는 답이 아니다 — 모든 빌드를 불필요하게 거부한다.)
  - **됐다** = ① 같은 `PROTOCOL_VERSION`이지만 다른 fork 레이아웃이 **`Hello` 디코드 전에** 거부된다
    ② 허용된 v19↔v20 조합은 정상 렌더된다 ③ 중첩 enum 또는 payload 필드가 바뀌면 ABI 게이트가 red.
- **M0-b 호환 창.** `MIN_SUPPORTED_PROTOCOL..=PROTOCOL_VERSION` (#70 옵션 1만). **M0-a 위에서만 의미를 갖는다** —
  버전 범위가 아니라 **명시적 `(protocol version, ABI epoch)` 허용표**로 표현한다. 창 혼자서는 무엇도 보장하지 않는다.
- **M0-c `ServerMessage` 태그 동결 테스트.** `client_message_wire_tags_preserve_protocol_15_order`
  (`src/protocol/wire.rs:1383` `[v]`)의 미러, 약 30줄.
- **M0-d 와이어 픽스처 코퍼스 + 최신성 CI 잡.** (조사 문서의 B3가 여기로 흡수됐다.)
  **✅ 2026-08-22 완료** — `docs/next/protocol/fixtures.json` + `src/protocol/wire_fixtures.rs`(테스트 2개).
  벡터 3개(`Hello`/`Welcome`/`Terminal`)가 전부 프로덕션 인코더 산출물이고, enum 서수는 실제 인코딩의
  선두 varint를 되읽어 생성하므로 타입과 표가 드리프트할 수 없다.
  > **D5와의 긴장, 그리고 그 해소.** D5는 "픽스처는 동기화 후"였다(머지에서 빨개지면 세탁이 되므로).
  > 그런데 tail 규칙(M-1 참조)이 **mx 태그를 머지 너머로 보존**하므로 관계가 뒤집힌다 — 이 코퍼스가
  > M-1에서 빨개지면 그건 소음이 아니라 **tail 규칙이 깨졌다는 유일한 기계적 증인**이다.
  > 남는 위험은 "빨강을 재생성으로 지우기"뿐이라, 실패 메시지 자체에 **분류 게이트**를 넣었다:
  > (a) enum 서수가 움직였다 → **머지 해소 버그다. 재생성 금지, enum 순서를 고쳐라.**
  > (b) 의도적 범프다 → 재생성 후 TS 코덱 재확인. RED 경로는 `Terminal` 13→2 모사로 실증했다.
- **M0-e 반복 정책 (동기화가 또 올 것이므로).** 동결은 영구 불변이 아니라 **이후 변경을 명시적 ABI 사건으로
  만드는 장치**다. 규칙 셋: ① **기존 픽스처는 덮어쓰지 않고 보존**하고 새 것을 추가한다 ② 와이어가 바뀌면
  `WIRE_ABI_EPOCH` 범프 + 새 픽스처를 **요구**한다 ③ 이전 ABI를 계속 받을지 거부할지 **명시적 호환성 결정을
  기록**한다. 이게 없으면 다음 동기화에서도 "CI red를 재생성으로 지우는" 같은 세탁이 반복된다.

**구현 위치 = fork.** M0-a는 정의상 upstream이 가질 이유가 없고(fork의 태그 테이블을 아는 건 fork뿐),
upstream은 18일에 148커밋이라 수용 리드타임이 통제 밖이다 — **통제 밖 의존성을 임계 경로에 두지 않는다.**
M0-b만 머지 이후 additive 분리 PR로 upstream에 제안한다(임계 경로 밖, 거절 시 손실 0).

**단독 가치**: #70이 원래 호소하던 "리모트 N대가 클라 업그레이드 한 번에 전멸"이 앱과 무관하게 해소된다.
**됐다** = 태그 테이블이 바뀌면 CI red · 서버 v20에 v19 클라이언트가 붙어 정상 렌더 · 게이트 green · 픽스처 커밋.

### M1 — `packages/herdr-client-ts` (헤드리스 코어, 폰 없음) — **착수됨 2026-08-22**

> **진행**: 와이어 코덱 슬라이스 완료(`a102abb9`) — envelope · `Hello` 인코드 · `Welcome`/`Terminal` 디코드 ·
> incremental `FrameReader` · `assertWelcomeAccepted`(error→version→**encoding**). vitest 59 green, `tsc --noEmit` 0.
> RN/Hermes 호환을 타입으로 강제(`"types": []`, `Buffer`/`TextEncoder` 없이 `Uint8Array`+손구현 UTF-8), `seq`는 `bigint`.
> `Hello` 바이트를 두 경로(실제 bincode · Rust 하네스 손유도)로 독립 유도해 일치 확인.
> **✅ "됐다" ①②③ 라이브 green (2026-08-22)** — 노드에서 격리 실서버 상대로 종단 관통:
> `agent.list`/`pane.list` 왕복 · `Hello`(TerminalAnsi) → `Welcome{version:20, encoding:1, error:null}` →
> `ObserveTerminal` → **실제 `Terminal` 프레임 수신**(`seq=1 100x30 full=true bytes_len=55923`, 선두
> `ESC[?2026h ESC[?25l … ESC[2J`), 그리고 새 출력 후 `seq=2 full=false` **diff 프레임**이 같은 소켓으로
> 도착(= 일회성이 아니라 살아있는 스트림) · **pane PTY 23x53 → 23x53 불변**. 5/5 무플레이크, 유저 데몬 9→9.
> **부수 확인**: 서버는 **tty를 요구하지 않는다** — Rust 하네스의 `portable_pty`는 불필요했다.
> 프레임 크기가 **관측자의 지오메트리**(100x30)이지 pane의 53컬럼이 아님도 라이브로 재확인(B4).
> **남은 것**: ssh 어댑터 인터페이스(RN 네이티브 모듈 — §2.4, 최대 신규 작업) · observe 세션 상태기계 ·
> 픽스처 코퍼스 테스트는 이미 green(④).
ssh 어댑터 인터페이스(노드=`ssh2`, RN=네이티브 모듈) · JSON API 클라이언트(요청 1개=채널 1개 계약 캡슐화) ·
최소 와이어 코덱(envelope / `Hello` 인코드 / `Welcome`·`Terminal`·`ServerShutdown`·`Pong` 디코드) ·
observe 세션 상태기계.
**단독 가치**: CLI로도 쓸 수 있는 TS SDK — herdr을 스크립트로 조종하는 다른 도구의 기반.
**됐다** = 노드에서 실서버 대상으로 ① 세션 스냅샷 파싱 ② `agent.list` 파싱 ③ observe로 `Terminal`
프레임 100개 수신, **그 동안 해당 pane의 PTY 크기가 불변** ④ 픽스처 코퍼스 테스트 green.
- ⚠️ **`pane.get`으로는 크기를 못 본다** — `PaneInfo`에 width/height 필드가 없다 (`src/api/schema/panes.rs:398-430` `[v]`).
  검증은 pane 안에서 `stty size`를 실행해 읽는다(`pane.send_input` + `pane.wait_for_output`) — 리시트가 쓴 방법이다.
- ⚠️ **크기 안정화 후에 측정한다.** 새 pane은 서버 PTY 크기로 시작해 **첫 가상 렌더에서 레이아웃 rect로 리사이즈**된다
  (`src/server/headless.rs:4074` `resize_panes = pane_infos.is_empty()`). 이 드리프트는 클라이언트와 무관하므로,
  연속 2회 같은 값이 나올 때까지 기다린 뒤 기준값으로 삼는다.

### M2 — 읽기 전용 앱 v1
리모트 목록 / Agents 홈 / 워크스페이스–탭–pane 브라우저 / **pane 뷰어(observe + TerminalAnsi + xterm WebView)**.
쓰기 없음, 폴링 기반(B9 우회). 설정·연결로그·트러블슈팅.
**단독 가치**: "폰에서 에이전트 상태를 보고 화면을 읽는다"가 성립 — 목적의 절반.
**됐다** = 실기기+실서버로 (a) blocked를 Agents 홈에서 60초 내 발견 (b) 해당 pane 화면을 읽을 수 있음
(c) **30분 시청 동안 데스크톱 레이아웃 무변화** (d) 백그라운드 왕복 10회에 강제종료 0
(e) **폰보다 넓은 pane(예: 200컬럼)에서 커서와 최신 출력에 도달할 수 있다** — 서버 크롭에서 살아남는 것과
폰 뷰포트 안에 보이는 것은 별개다([`03-blockers.md`](./03-blockers.md) B4). v1 기준은 **수동 이동(핀치줌·가로스크롤) 후 도달 가능**이고,
"열자마자 보인다"를 원하면 클라이언트가 ANSI 커서 위치로 **auto-pan/follow**하는 동작이 별도로 필요하다 — 그건 v1 범위 밖.

### M2b — 원격 설정 + 키 보관 (**2026-08-23 신설 — 계획 공백이었다**)

앱이 어느 서버를 볼지 정하는 유일한 통로가 지금은 **`app.json`의 `expo.extra.herdrRemotes`**다
(`modules/herdr-ssh/src/app-connections.ts:47`). 그건 두 가지 이유로 최종 답이 될 수 없다:

1. **개인키가 번들에 구워진다.** `app.json`은 커밋되는 파일이고 APK에 그대로 실린다.
   2026-08-23에 QA 랩 설정을 넣는 것만으로 워킹트리에 평문 OpenSSH 키가 올라왔고, `git add -A` 한 번이면
   커밋될 위치에 있었다. 스로어웨이 키였지만 경로가 그렇다는 게 문제다.
2. **유저가 앱을 쓸 수 없다.** 목표 1번("휴대폰으로 내 원격 터미널 에이전트 사용")은 유저가 자기 서버를
   등록할 수 있어야 성립한다. 재빌드해야 원격이 바뀌는 앱은 그 목표를 만족하지 않는다.

**정본은 이미 코드가 지목하고 있다** — `modules/herdr-ssh/src/remote-config.ts:12`:
*"`expo-secure-store` (already a dependency), and `HerdrSshRemoteConfig` is shaped so that swapping …"*.
즉 자료구조는 준비돼 있고 **보관처와 UI가 없다.**

**범위**: 설정 화면(원격 추가/삭제/편집) · 키를 `expo-secure-store`에 저장(번들·로그·크래시리포트에 안 남게) ·
`app.json` 경로는 **개발 전용으로 강등**(있으면 읽되, secure-store가 이기고, 릴리즈 빌드에서는 무시).
**QR로 추가**는 닫힌 전제상 herdr *데스크톱 클라이언트*의 기능이고(사이드바 노드 우클릭 → show qr),
앱 쪽은 그 QR을 읽어 원격을 등록하는 소비자다 — 신규 페어링 프로토콜 없음, 인증은 ssh 그대로.

**됐다** = ① 앱에서 원격을 추가해 재빌드 없이 붙는다 ② 키가 `app.json`·번들·logcat 어디에도 안 남는다
③ 앱 삭제 시 키가 같이 사라진다 ④ Android·iOS 각각 QA PASS(별도 에이전트).

### M3 — 입력 (와이어 쓰기 없이)
소프트 키보드 → `pane.send_input{text}` · 액세서리 키 행(Enter/Esc/Ctrl-C/화살표/Tab) → `keys[]` ·
퀵 커맨드(y/n/승인).
**단독 가치**: "폰에서 승인 눌러주기" 완성 — 목적의 나머지 절반.
**됐다** = 폰에서 승인 프롬프트에 y → observe 스트림에 반영 확인. 그 동안 PTY 크기 불변.

### M4 — transport 생존성 ([`05-orca-transport.md`](./05-orca-transport.md) 전부)
**됐다** = 기내모드 토글 ×10 / Wi-Fi↔셀룰러 전환 ×10 / 30분 백그라운드 후 복귀 — 전부 수동 개입 없이
자동 복구. **강제종료로만 낫는 상태 0건.**

### M5 — 푸시 (blocked 한정)
herdr 플러그인 1개 — `pane.agent_status_changed`에 훅을 걸고,
> ⚠️ **이 절의 인용 3개는 틀렸다** (`.prd/09` §B4 P1이 실측 정정). `events.rs:75`는 `Subscription` variant,
> `:222`/`:253`은 `EventKind`/`dot_name`이며 **어느 것도 페이로드가 아니다.** 실제 페이로드는
> **`EventData::PaneAgentStatusChanged` (`src/api/schema/events.rs:543-556`)** — `pane_id`/`workspace_id`가 필수다.
> 구현 전에 P2(presentation 변경만으로도 재발화 → 센더 쪽 coalesce)와 P3(`runtime.rs`의 in-flight 32 상한이
> 초과분을 **버린다** — 훅 경로 고유의 drop cliff)를 설계에 반영하라.

`HERDR_PLUGIN_EVENT_JSON`을 읽어 **네트워크를 치지 않고** 큐 파일에 append만 한다. 드레인은 별도
launchd/systemd 센더가. 훅 런타임에 타임아웃·재시도·DLQ가 없기 때문 `[i]`.
훅은 `event_hub.push`보다 **먼저** 실행되므로(`src/app/api.rs:782-784` `[v]`) 링 축출·드레인 상한(B9)을
구조적으로 우회한다. 등록은 `herdr plugin link`, **서버 재시작 불필요** `[i]`.
**제약**: `Done`은 전역 `seen` 비트라 데스크톱이 그 탭을 보면 사라진다 `[i]` →
**디바이스 독립적인 건 `blocked`뿐.** v1 푸시는 blocked만.
**됐다** = 데스크톱을 안 보고 있을 때 blocked 발생 → 폰 알림 → 탭 → 해당 pane 도달, 5회 연속.

### M6 — 제어·스크롤·리타겟 (~~서버 변경 동반~~ → **앱 배선만**)

> **⚠️ 2026-08-23 재조사: 이 절의 "서버 변경 동반"은 틀렸다. 와이어가 양쪽 다 이미 있다.**
>
> | 조각 | 서버 | TS 코덱 | 앱 |
> |---|---|---|---|
> | `RetargetTerminal` | ✅ 종단 처리 (`src/server/client_transport.rs:988` → `headless.rs:3368`, 테스트 4개) | ✅ `encodeRetargetTerminal(target, mode)` (`messages.ts:232`) | `PaneObserver.retarget(paneId)` 존재, **호출자 0** |
> | 제어 승격 | ✅ 같은 메시지의 `mode` | ✅ `TerminalSessionModeTag = { Observe: 0, Control: 1 }` (`constants.ts:185`, 태그 동결 + 픽스처 바이트 고정) | `retarget()`에 mode 인자 **없음** |
> | 스크롤백 | `wire.rs:455`에 host scrollback 행 수 필드 | 미조사 | 미착수 |
>
> **즉 제어 승격은 별도 `ControlTerminal` 메시지가 아니라 `RetargetTerminal`의 mode다** —
> `Observe`는 unit variant, `Control`은 `takeover: bool`을 실어 프레임이 정확히 1바이트 길다.
>
> **그리고 `app/h/[remoteId]/pane/[paneId].tsx:56`의 주석이 stale이다** —
> *"herdr has no message to move an observe target, so even a warm channel could not retarget today"*
> 라고 적혀 있는데 그 메시지는 존재하고 서버가 처리한다. M6 작업 시 함께 고칠 것.

**남은 실제 작업 = 앱 배선 2단위** (per-unit dispatch):
- **M6a** 스와이프 → `retarget(paneId)`. ✅ **완료** (`e383868e`) — 와이어로 재연결 부재 실증, 기기 실측은 QA
- **M6c** 스크롤백 열람

**됐다** = pane 스와이프 전환이 재연결 없이 <200ms · 스크롤백 열람.

---

### ⛔ M6b(제어 승격) 삭제 — §2.3이 이미 반대를 결정했다 (2026-08-23)

이 마일스톤은 *"입력 순간에만 `ControlTerminal`로 임시 승격하고 즉시 복귀"* 를 요구했다.
**그건 이 앱의 아키텍처 결정과 정면으로 모순되고, 그 결정이 이미 출하돼 양 플랫폼 QA를 통과했다.**

`.prd/02-architecture.md` §2.3 "쓰기는 JSON API — 와이어로 쓰지 않는다"가 근거와 함께 정한 것:

| | 서버 동작 | 확인 |
|---|---|---|
| `observe_terminal_client` | `(cols, rows)`를 **`info!` 로그에만** 쓴다. 리사이즈·락 없음 | `src/server/headless.rs:1916-1940` 직독 |
| `control_terminal_client` | `attach_terminal_client(…, takeover)`로 위임 | `:1942-1948` |
| `attach_terminal_client` | `direct_attach_resize_locks` + 공유 런타임을 effective size로 리사이즈 | `:3068~`, `resize_shared_runtime_to_effective_size` `:1097` |

→ **제어 승격은 공유 PTY를 폰 그리드로 리사이즈하고 락을 건다. 데스크톱 파괴다.**
§2.3의 판단: *"이 분리 하나로 세 블로커가 동시에 사라진다 — 그리드 락 · takeover 경쟁 · stale attach 미회수."*

**그리고 M3가 그 결정 위에서 출하됐다**: 입력은 `pane.send_input{text?, keys[]}`로 가고,
**PTY 불변 · `resize` 이벤트 0건**이 M3의 측정된 계약이다 (Android 4/4, iOS 11/11 바이트 일치,
QA가 와이어 1468파일 전수 grep으로 확인). M6b를 구현하면 **방금 양 플랫폼에서 통과한 계약을 스스로 깬다.**

**남는 유일한 M6b 논거는 비용이다** — `pane.send_input`은 호출 1회 = ssh exec 1회(B8)라 빠른 타이핑에서 비싸다.
그러나 스트림으로 쓰려면 control 모드여야 하고(observe 모드는 입력을 조용히 버린다 — `mode == TerminalObserve`면
`return false`), control 모드는 리사이즈한다. **즉 B8 비용은 데스크톱을 안 부수는 값이고, §2.3이 그 거래를
알고 한 것이다.** 되살리려면 새 근거가 필요하지 이 마일스톤 문장으로는 안 된다.

수용 기준의 *"제어 해제 시 데스크톱 크기 자동 복원"* 도 함께 삭제 — 승격을 안 하면 복원할 것이 없다.

---
