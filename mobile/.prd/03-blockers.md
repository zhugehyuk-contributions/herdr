# 03 — 선행 차단 요소 (herdr 쪽이 먼저 바뀌어야 하는 것)

앱 코드보다 앞선다. **B1(프로토콜 완전일치)이 1순위이며 앱의 존재 조건**이고, 나머지는 전부 그다음이다.
B1은 이미 herdr-mx **#70**("Fleet upgrade window")에 설계까지 올라와 있다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

### B1. 프로토콜 완전일치 — 1순위, 앱의 존재 조건

- **막는 것**: `check_client_version`이 older도 newer도 거부한다 (`src/protocol/wire.rs:1218-1237` `[v]`).
  `PROTOCOL_VERSION = 20` (`wire.rs:23` `[v]`). 브리지 경로도 같은 등호 게이트를 통과해야 한다 `[i]`.
- **왜 치명적**: 범프 빈도를 측정하면 **79일에 11회, 평균 7.2일마다**다 —
  v9(05-21) v10(05-23) v11(05-24) v12(05-30) v13(06-06) v14(06-13) v15(06-29) v16(07-05) v17(07-17)
  v18(07-23) v19(08-01) v20(08-08) `[v]`. 데스크톱 CLI는 서버와 같이 올라가지만 **앱스토어 바이너리는
  그럴 수 없다.** 유저가 자기 맥에서 `git pull` 한 번 하면 폰 앱이 그 순간 벽돌이 된다.
- **범위**: `MIN_SUPPORTED_PROTOCOL..=PROTOCOL_VERSION` 창 — **#70에 이미 설계까지 올라와 있다.**
  함수 1개 + 상수 1개 + 브리지 비교 1곳. 단 창만으로는 부족하다: 창 안에서 **어떤 구조체 레이아웃이
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

### B10. `pane.read`는 변경 검출에 못 쓰고, 유저 pane을 스크롤시킬 수 있다

`PaneReadResult.revision`이 생성 지점 전부 하드코딩 0이고, 와이어 `pane.read`는 `intent`가
`serde(skip)`이라 항상 Interactive로 들어가 조건이 맞으면 서버가 실제 alt-screen 스크롤 캡처를 돌린다 `[i]`.
즉 "폴링으로 pane 내용 읽기"가 **유저의 살아있는 에이전트 pane을 물리적으로 스크롤시킨다.**
→ `intent`를 와이어에 노출하거나 기본값을 Passive로(5줄). 그 전까지 **`pane.read` 반복 호출 금지**,
pane 화면은 반드시 observe 스트림.

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
