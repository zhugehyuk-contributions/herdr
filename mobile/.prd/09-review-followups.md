# 09 — 외부 리뷰 후속 (2026-08-22)

`packages/herdr-client-ts` 첫 슬라이스에 대한 외부 리뷰 산출. 3엔진 합의 패널(trinity) + 병렬 검증 세션 다수가
같은 소스를 훑었다. **판정이 갈린 것까지 포함해** 여기 남긴다 — 기각된 후보도 다시 제기되지 않도록 근거와 함께.

증거 표기 — `[확정]` 소스 대조로 확인 · `[기각]` 조사 결과 도달 불가 · `[미검증]` 제기됐으나 아직 안 봄.

## A. 수리 완료 (11건) — 커밋 `bbedbeb6`, 2026-08-22

> 전부 RED를 먼저 잡고 고쳤다. 게이트: vitest **122**(101→+21) · tsc 0 · live 3 · live-ssh 4, dispatcher 직접 재실행.
> ⑨는 측정으로 닫았다 — 배가 시 비율 **3.86×(이차) → 2.00×(선형)**, 32MiB/64KiB에서 `67,108,868B = 2S` 실측.
> ⑩은 서버 소스로 응답 형태를 **확정**하고(추측 금지 지시) 구현했다 — `SubscriptionStarted`
> (`src/api/server.rs:679-686`, 와이어 이름은 서버 자기 테스트 `:1292`로 확인).
>
> *(아래 표는 무엇을 고쳤는지의 기록이다. 닫힌 항목이므로 다시 열지 마라.)*

| # | 결함 | 위치 | 왜 아픈가 |
|---|---|---|---|
| 1 | **env 키 미인용 → 원격 명령 주입** | `src/transport.ts:575-590` | 값만 `shellQuote`하고 키 이름은 그대로 보간. `X=$(touch …)` 키가 원격 셸에서 실행된다 — **PoC로 마커 파일 생성 확인됨.** 공개 API(`@herdr/client-ts/node`)라 호스트별 env를 설정하는 앱이면 RCE |
| 2 | **`onError` 계약 위반** | `:388-393`(문서) vs `:476-495`(코드) | 문서는 "Terminal either way, 정확히 한 번"인데 corrupt 경로는 루프가 계속 돌아 같은 청크에서 `onMessage`가 뒤따른다. 앱이 문서대로 정리하면 정리된 터미널에 ANSI가 적용되고, 재연결하면 **스킵 가능한 프레임 하나에 연결이 플랩**한다 |
| 3 | **`onUndecodable` 미격리 → 프레임 유실** | `src/stream.ts:104-115` | 진단 콜백이 던지면 루프 중단 → `FrameReader`가 이미 배치를 소비한 뒤라 뒤 `Terminal`이 영구 유실. `cf05b11b`에서 고친 버그의 **콜백 경로 재발** |
| 4 | **`maxFrameSize` 미검증** | `src/framing.ts:34-36`, 소비 `:78-84` | `NaN`이면 `claimed > NaN`이 항상 false → 광고된 상한 무력화 → `0xffffffff` 프리픽스에 pending 무한 성장 |
| 5 | **이벤트 스트림 사망 무통지 + 구독 실패 시 채널 누수** | `:355-368`, `:209-266` | `onLine`/`close()`만 노출. 채널이 죽어도 구독자는 영원히 살아있다고 착각 — **LTE 끊김·원격 재시작은 모바일 일상**. 게다가 채널을 먼저 연 뒤 `stringify`/`write`가 실패하면 닫을 핸들이 사라진 채 exec 채널이 상주한다(같은 파일 `jsonApi.ts:171-181`은 `finally`로 닫는데 여기만 빠짐) |
| 6 | **JSON API `id` 에코 미검증** | `src/jsonApi.ts:113-151`, `:171-180` | 누락/비문자열 `id`가 `""`로 통과하고 `call()`이 에코를 확인하지 않는다. 요청1개=연결1개이므로 상관 실패는 곧 와이어 손상인데 성공으로 받는다 |
| 7 | **`ServerMessageChannel`에 진단 카운터 부재** | `:481-495` vs `src/stream.ts:59-67` | `constants.ts:4-9`가 **포크 태그 스큐를 스스로 적어놨다**(mx·upstream 둘 다 `PROTOCOL_VERSION=20`인데 `Terminal` 13 vs 2). `assertWelcomeAccepted`(`messages.ts:249-262`)는 **버전만** 본다 → upstream 서버에 붙으면 **핸드셰이크 green → 전 프레임 오분류 → 콜백 optional → 화면 검음·에러 0건·진단 0** |
| 8 | **`pty: false` 요구가 잘못된 파일에 있다** | `src/node/sshTransport.ts:174-176` | `src/transport.ts:78-81`이 스스로 "RN 모듈이 맞춰야 할 지식은 여기"라고 선언해놓고, **실패가 전면적·무음인**(pty line discipline이 모든 프레임 페이로드를 망친다) 요구를 RN 저자가 안 읽을 파일에 뒀다 |
| 9 | **`FrameReader` 누산기 Θ(S²/c)** | `src/framing.ts:53-61`, `:88-90` | push마다 `pending+chunk` 전체 재할당·복사, 완성 시 또 `slice`. **32 MiB 페이로드 = 64 KiB 청크에서 누적 ~8.05 GiB, 16 KiB에서 ~32 GiB.** 서버가 kitty 그래픽 프레임에 32 MiB를 실제로 허용하므로 **합법 트래픽에서 도달 가능** → Hermes GC 스톨/OOM |

## B. 기각된 후보 (다시 제기하지 마라)

| 후보 | 판정 | 근거 |
|---|---|---|
| `Compressed`(태그 11) 래핑된 `Terminal`을 스킵해 유실 | **`[기각]`** | 압축은 semantic 분기에만 걸린다(`src/server/render_stream.rs:65-90`). `TerminalAnsi` 분기(`:92-124`)는 raw로 보낸다. TS는 `TerminalAnsi`를 요구·검증하므로(`messages.ts:243-262`) 이 코덱이 `Compressed`를 만날 경로가 없다 |
| stderr 무한 증가 | **`[기각]`** | 브리지는 순수 소켓↔stdio 펌프(`src/remote/unix.rs:568-590`)이고 디스패치가 로깅보다 먼저 돈다(`src/main.rs:549-555`). stderr는 기동/런타임 오류뿐이고 그 뒤 채널이 닫힌다 — 장수 생산자가 없다 |

## A2. 패널 최종 MUST-FIX — 수리 완료 (커밋 `753d8960`)

**corrupt 뒤 화면 재동기화.** `bbedbeb6`에서 corrupt를 `unsupported-variant`와 같이 건너뛰게 만든 근거
("길이 프리픽스가 경계를 고정하니 뒤 프레임들은 멀쩡하다")가 **와이어 층에서만 참**이었다 —
`Terminal`은 diff 기반 ANSI 상태 머신이라 corrupt한 diff를 버리고 후속 diff를 적용하면
**화면이 영구적으로 틀린다**. `seq`/`full` 필드가 그 상태 의존성의 증거다.

패널은 재연결을 권했으나 프로토콜에 전용 수단이 있었다 — **`RequestFullFrame`**(태그 11, 필드 없음).
`src/protocol/wire.rs:464-467`이 이 시나리오를 그대로 서술한다 `[v]`. 채널을 유지한 채 화면만 복구하므로
모바일에서 재연결(새 exec 채널+핸드셰이크+가시적 스톨)보다 싸다.

**라이브 검증** — 이 설계의 유일한 미검증 홉이었다: control window(무요청 1초) **0 프레임** →
5바이트 요청 → `seq=4 full=true bytes_len=55923`(초기 풀 리드로와 일치, diff는 115B).
컨트롤 윈도우가 있어야 "어차피 올 리페인트"가 배제된다.

> **부수 정정**: dispatcher 브리핑이 "`reset_baseline()`이 `repaint_pending=true`를 세운다"고 했으나 **틀렸다.**
> 그건 `false`로 세우고 `BlitEncoder::new()`를 넣는다(`render_stream.rs:36-47`); `true`는 `request_repaint()`다.
> `full=true`의 실제 출처는 `render_ansi.rs:90-92`의 `full = repaint || **prev.is_none()** || dim-change`에서
> 새 인코더의 `last_frame`이 `None`이기 때문. 결론은 맞고 경로가 달랐다 `[v]`.

## B2. 수리 중 새로 드러난 것 (2026-08-22)

| # | 항목 | 위치 | 등급 |
|---|---|---|---|
| ~~N1~~ | **✅ 닫힘 `571ead04`** — `WireLayoutProbe` 신설(`src/layoutProbe.ts`). 판정 = `한 태그 반복 ≥5 AND 디코드된 Terminal 0 AND armed`. 분포로 세는 근거는 서버 소스 논증(정상 트래픽은 이질적, 스큐는 단조 반복). 무장은 `send()`에서 호출자 프레임을 되읽어 감지 → 기존 호출자가 그대로 오탐 리시트가 된다(`[ssh] layout probe: undecodable=0 verdict=none`). **한계를 코드에 기재**: 추론이지 증명 아님 · 구조상 위음성 · 필드 이동 스큐엔 무력 · 진짜 해법은 M0-a. | `[해소]` A-⑦(`undecodableCount`)은 **증상을 한 줄로 진단 가능하게** 만들 뿐 **스큐를 탐지하지 못한다.** 진짜 수정은 **레이아웃 프로브** — 예: `ObserveTerminal` 후 첫 `Terminal`이 기대한 태그로 도착하는지 확인한 뒤에야 스트림을 healthy로 선언. mx·upstream이 둘 다 `20`인 한 버전 비교는 무의미하다 |
| ~~N2~~ | **✅ 닫힘 `571ead04`** — `createHostTimer(host)`가 타이머 부재 시 throw(메시지가 빠진 능력과 고치는 법을 명명). 주입 경로는 그대로 우선. `setTimeout`/`clearTimeout` **둘 다** 요구 — 전자만 있으면 데드라인이 무장되고 취소 불가라 **멀쩡한 채널을 나중에 죽인다**. | `[해소]` — C5와 같은 항목이나 A-⑩ 이후 **`subscribe()`가 영원히 대기**할 수 있게 됐다(ack를 기다리는데 타임아웃이 없다) |
| **N5** | `desynchronizesScreen`가 **default-yes 술어**다 | `src/errors.ts:41` | `[확정]` — `code !== "unsupported-variant"`라서 **향후 어떤 에러 코드든 조용히 "화면을 desync한다"를 상속**한다. 새 `layout-mismatch`는 판정이 먼저 단락시켜 도달하지 않지만 형태 자체가 함정이다 → allow-list로 뒤집어라 |
| **N6** | `src/node/sshTransport.ts:169`가 전역 `setTimeout`을 직접 쓴다 | 같은 곳 | `[확정]` · 낮음 — Node에선 무해하나 **`src/node` 엔트리는 N2의 fail-fast 보장을 못 받는다** |
| **N4** | `Compressed` 인플레이터 부재 | `src/messages.ts` | `[확정]` · 낮음 — `wire.rs:462-467`이 말하는 desync 원인 **둘 중 나머지 절반**("compressed frame that failed to inflate")은 이 코덱에서 **시도조차 불가**하다. `TerminalAnsi` 전용인 한 도달하지 않으나, `SemanticFrame`을 받아들이는 순간 되살아난다 |
| **N3** | `id: ""` 예외는 **서버 봉투 자체의 구멍**이다 | `src/api/server.rs:159-172`, 인코드 폴백 `:819` | `[확정]` — `invalid_request`는 클라이언트가 **상관시킬 수 없는 유일한 응답**이다. 요청1개=연결1개인 지금은 무해하나, id 기반 상관 계층은 이 API에 대해 **완전히 엄격해질 수 없다** |

## B3. 앱 이식 중 드러난 서버 쪽 갭 (2026-08-22, M2 5단계)

| # | 항목 | 근거 | 등급 |
|---|---|---|---|
| **S1** | **herdr 와이어에 시계가 없다** | `AgentInfo`/`PaneInfo` 어디에도 타임스탬프가 없다(스키마 실측). `revision`/`state_change_seq`는 카운터지 시각이 아니다 | `[확정]` · **서버 이슈 후보.** 결과: **최종 보고 없이 죽은 에이전트가 영원히 `working`으로 읽힌다.** orca는 `updatedAt` 30분 decay로 처리하는데 herdr엔 그 재료가 없다. 목업의 `· 4m` / `· 2m41s` 열도 구현 불가. **필드 추가 없이는 못 고친다** |
| **S2** | `manual_label`을 pane 핸들로 쓰고 있다 | 스키마상 이 필드는 pane의 **수동 개명**이다. 4단계 mock이 거기에 herdr 표기(`1-1`)를 넣었고 5단계가 그대로 소비했다 | `[확정]` · 낮음 — 실서버에선 개명 안 된 pane이 `pane_id`로 폴백한다(테스트 고정). **6단계 실배선 때 확인 필요** |
| **S3** | `oxfmt --check`가 무신호다 | 설정 파일 부재로 기본값 동작(`No config found, using defaults`) → `src`+`app`만 돌려도 **116/116 전부** format issue. `.prd/assets/mockup.html`에선 파싱 에러 exit 2 | `[확정]` — **`cargo fmt --check` 무신호(01-spec)의 2호기.** 손대면 안 된다: 재포맷은 **byte-identical 75개를 전부 깨뜨려 이식 불변식을 파괴**한다 |

## B4. M5 구현 중 드러난 계획 오류 (2026-08-22)

| # | 항목 | 실측 | 등급 |
|---|---|---|---|
| **P1** | **`04-milestones.md` M5의 인용 3개가 전부 틀렸다** | `events.rs:75`는 **`Subscription`** variant(enum은 `:18`에서 시작), `:222`/`:253`은 `EventKind`/`dot_name`이다. **어느 것도 페이로드가 아니다.** 실제 페이로드는 **`EventData::PaneAgentStatusChanged`, `src/api/schema/events.rs:543-556`** — `pane_id`/`workspace_id`가 **필수**다(`Option`인 건 `:76-83`의 **구독 필터**쪽) | `[확정]` — 문서 정정 필요 |
| **P2** | **계획이 놓친 재발화**: `pane.agent_status_changed`는 **presentation만 바뀌어도** 발화한다 (`src/app/api.rs:609-611`이 `previous_agent_status != agent_status \|\| previous_presentation != presentation`) | 한 번의 blocked 에피소드가 **여러 레코드**를 큐에 넣는다. 훅이 아니라 센더 쪽 coalesce 창으로 처리 | `[확정]` |
| **P3** | **계획이 놓친 유실 경로**: 훅 런타임에 타임아웃·재시도·DLQ가 없다는 건 맞으나, `runtime.rs:12`가 **in-flight 32개 상한**을 두고 초과분을 **버린다**(`:239`의 `let _ = self.start_plugin_command(...)`) | 훅 경로가 B9의 링 축출은 우회하지만 **자기 고유의 drop cliff**가 있다. 버스트에서 유실 가능 — 완화는 훅을 수 ms로 유지하는 것뿐 | `[확정]` |
| **P4** | 계획의 나머지 `[i]`는 **전부 사실**로 확인됨 | 훅이 `event_hub.push`보다 먼저(`api.rs:782-784`) · `HERDR_PLUGIN_EVENT_JSON` 이름 정확(단 봉투가 **snake_case**이지 dot name이 아니다) · `Done`이 `seen` 비트라 디바이스 의존(`api_helpers.rs:104-107`, **라이브 재현**: 같은 pane·같은 명령인데 포커스 있으면 `idle`, 없으면 `done`) · `plugin link`가 **서버 재시작 불필요**(`runtime.rs:221`이 매 hookable 이벤트마다 `refresh_installed_plugins()`) | `[확정]` |

## C. 확정됐으나 이번 범위 밖 (다음 유닛)

| # | 항목 | 위치 | 등급 |
|---|---|---|---|
| C1 | **stderr를 청크마다 독립 UTF-8 디코드** → 멀티바이트 경계에서 `경고` → `���고` | `src/node/sshTransport.ts:67-68`, 노출 `:90` | `[확정]` — 계약상 **stderr가 브리지의 유일한 오류 보고 수단**이라 한글 오류가 깨지면 진단이 죽는다. `StringDecoder` 또는 close까지 버퍼링 |
| C2 | `ServerMessageReader` ↔ `ServerMessageChannel` 상태기계 중복 + **정책 드리프트 실재** | `src/stream.ts:38-116` vs `src/transport.ts:408-495` | `[확정]` — 같은 바이트가 두 레이어에서 다른 재연결/드롭 동작을 낸다. A-2 수리가 정책을 일치시키지만 **구조 중복은 남는다** |
| C3 | `SshChannel.close()` 멱등성 미구현 | `src/node/sshTransport.ts:82-105`, 계약 `transport.ts:129-130` | `[확정]` — 두 소유자가 정리를 경합하면 `end()`/`close()`가 두 번 |
| C4 | `NdjsonChannel` 이중 waiter 덮어쓰기 | `src/transport.ts:209-299` | `[확정]` — 동시 `nextLine` 2개면 첫 waiter가 덮여 첫 Promise가 영원히 매달린다 |
| C5 | `hostTimer` 무음 no-op | `src/transport.ts:167-192` | `[확정]` — 타이머 API가 없으면 **문서화된 15초 타임아웃이 무한 대기**가 된다. **N2 참조 — A-⑩ 이후 위험도가 올랐다** |
| C6 | `seq`가 u128 마커·u64::MAX 초과를 수용 | `src/messages.ts:152-179`, `src/varint.ts:105-147` | `[확정]` — 불가능한 seq를 받으면 갭/순서 로직이 그 값으로 전진해 이후 합법 프레임을 전부 stale로 버린다 |
| C7 | `encodeHello`가 enum 멤버십 미검증 | `src/messages.ts:80-100` | `[확정]` — 특히 `ClientKeybindings` 태그 1은 `Local{keys_toml}`인데 페이로드 없이 태그만 나간다 → **구조적으로 잘린 variant** |
| C8 | `JsonApiError`/`JsonApiProtocolError`에 Hermes 프로토타입 복구 누락 | `src/jsonApi.ts:50-68` vs `src/errors.ts:34-39` | `[확정]` — 다운레벨 Hermes 빌드에서 **JSON API 에러만** `instanceof` 실패 → 서버 거절이 알 수 없는 전송 실패로 오분류 |
| C9 | `connectionCount` 동어반복 게터 | `src/node/sshTransport.ts:115-155` | **삭제 후보.** 단 `test/live-ssh/`가 다중화 계약 검증에 쓴다(변이에서 `expected 7 to be 1`로 실제 검출) → 프로덕션에서 지우고 테스트는 `Client` 생성 스파이로 |
| C10 | `subscribe`가 `encodeJsonApiRequest`를 재사용하지 않고 손직렬화 | `src/transport.ts:357-366` vs `src/jsonApi.ts:104-111` | `[확정]` — 지금은 바이트 동일하나 봉투 규칙이 바뀌면 **구독만** 조용히 갈라진다 |
| C11 | `decodedBefore: unknown[]`의 레이어 다형성 | `src/errors.ts:22-40` 외 3곳 | `[확정]` — `FrameReader`는 페이로드를, `ServerMessageReader`는 메시지를 넣는다. 캐스트 의존 |
| C12 | **잘린 종료가 깨끗한 종료와 구분되지 않는다** | `src/framing.ts:38-45,53-97`(finalize 부재) · `src/transport.ts:441-446`(close가 reader를 안 본다) · `src/jsonApi.ts:78-101`(`LineAccumulator` 동일) | `[확정]` — 부분 프레임을 든 채 닫히면 재현상 `errors:[]` · `closes:[{exitCode:0}]`로 **정상 경계와 동일**하게 보고된다. 최종 LF 없는 완전한 JSON 응답도 "truncated"가 아니라 `API bridge channel closed (exit=0)`이 되고, 이벤트 스트림 재현에서는 **버퍼된 이벤트가 조용히 소실**됐다. **LTE가 끊기는 모바일에서 "잘림"과 "정상 종료"가 같아 보이면 안 된다.** 기존 테스트는 부분 버퍼링과 close 전달을 **따로** 증명할 뿐 둘을 결합한 케이스가 없다 → `end()`/finalize 도입 + 결합 테스트 |

## D. 레포 규약 위반 (별도 축)

- **runtime/client 가이드레일** — 처음 "위반"으로 제기했으나 **`[기각]`**. 가이드레일은 *"Before **adding** state, API fields, events, commands, or socket messages"*를 게이트하는데 이 작업은 그중 아무것도 추가하지 않았고, `ObserveTerminal`은 `bffc4a82`(2026-06-30)로 **2개월 선행**한다 `[v]`. 기존 채널의 **두 번째 소비자**일 뿐이다. → 남은 것은 규칙이 아니라 **의존성 전략**이며 [`02-architecture.md`](./02-architecture.md) §Tensions의 **D8**로 재정의됨.
- **"No god objects"** (`AGENTS.md` §Universal Project Rules) — `src/transport.ts` 591줄이 채널 분류·브리지 커맨드·호스트 타이머·NDJSON 버퍼링·구독·프레임 디코딩·진단·셸 인용을 전부 소유한다. **C2와 같이 처리하는 게 옳다** — 정책 통일과 모듈 분할은 같은 작업이다.

## E. `format:check` — 닫힘 (2026-08-22)

3갈래 결정으로 올려뒀던 것을 **②(범위 축소 + 채택)**로 실행했다. 근거는 유저가 Rust 쪽에서 같은
딜레마에 낸 답이다 — `808b5ca7 style: rustfmt the tree ... kept separate from the feature commit so
that diff stays scoped`: 우회가 아니라 트리를 고치되 커밋을 분리한다.

`.oxfmtrc.json` 신설(`semi:false`, `singleQuote`, `printWidth:100`, `trailingComma:"none"`,
`ignorePatterns:[".prd/", "**/*.md"]`) 후 `npm run format` 1회. **printWidth 100은 취향이 아니라
실측이다** — 110이면 불일치 파일이 85개, 120이면 111개로 **늘어난다**(넓은 한계가 저자가 일부러 끊은
줄을 합치기 때문). 56파일 재포맷, 동작 변경 없음, 별도 커밋.

`format:check`가 처음으로 **exit 0**이며 이제 실제 신호다.

## F. Rust 테스트 게이트 — 실패 7건 중 6건은 테스트 결함이었다 (2026-08-22)

`cargo nextest run --all-features --retries 2 --no-fail-fast`를 이 브랜치에서 돌리면
**3890건 중 7건 실패**한다. 머지 전 베이스라인(3604건)에서도 **이름까지 동일한 7건**이 실패했으므로
M-1 업스트림 머지가 만든 신규 실패는 **0건**이다 `[v]`.

**6건의 근본 원인은 앰비언트 환경 유출이다.** 개발 셸이 herdr 세션 안에 있으면 `HERDR_SESSION`이
테스트 프로세스로 상속되고, `main_server_remote_targets()`가 그 값을 메인 서버의 자기 타깃으로
읽는다(`src/app/api/remotes.rs:106-117` → `session::active_name()` → `src/session.rs:96-101`).
그래서 `remote.add`에 `local:dev`를 넣는 테스트가 `duplicate_remote_target`으로 거절되고,
`add["result"]["remote"]["id"].as_str().unwrap()`이 `None`에서 패닉한다(`remotes.rs:273`).
**이 세션의 셸이 정확히 `HERDR_SESSION=dev`였다** — 즉 테스트가 자기를 돌리는 사람의 세션 이름에
따라 결과가 갈린다. CI(세션 밖)에서는 green이므로 아무도 못 본다.

판별 실측 `[v]`:

| 실행 | 결과 |
|---|---|
| `HERDR_SESSION=dev` 상속, 전량 | 3883 passed / **7 failed** |
| herdr env 6종 제거, 전량 | 3889 passed / **1 failed** |
| 같은 단위 테스트 단독, env 있음 / 없음 | FAIL / **PASS** |

**수리 방향**: 테스트가 앰비언트 env에 의존하지 않도록 `test_app()`이 `HERDR_SESSION`을 명시적으로
비우거나, `main_server_remote_targets()`를 주입 가능하게 만든다. 지금은 **테스트 결함**이지
제품 결함이 아니다 — 실사용에서는 자기 세션을 원격으로 다시 등록하는 것을 막는 의도된 동작이다.

**잔존 1건 — 닫힘 (2026-08-22, `origin/mx` 머지로).**
`live_handoff_keeps_unmanaged_agent_name_bound_to_saved_session`은 머지 전 단독 실행에서 3/3 실패
(`agent.get` → `agent_not_found`, `tests/live_handoff.rs:1306`)였고, `origin/mx` 16커밋을 머지한 뒤
**3/3 통과**한다. 전량도 **3981 passed / 0 failed**.

**내 예측이 틀렸다는 것을 함께 남긴다.** 나는 "16커밋이 `src/detect/`·`src/pane.rs`를 건드리지 않으니
이 실패는 머지로 해결되지 않는다"고 적었다. 파일 집합만 보고 인과를 추론한 것이고, 실제 수정은
세션 프로브/wedged-server 계열(`7babe1a3`, `2461f4d0`, `c290ae61`)에서 왔다. 어느 커밋인지는
bisect하지 않았으므로 **미확정으로 남긴다** — "머지가 고쳤다"까지만이 실측이다.

**따라서 herdr 코어 잔여 결함은 없다.** 게이트는 전부 green이다.

---

## G. 스냅샷이 마운트 시점에 얼어붙던 문제 — 닫힘, 잔여 1건 (2026-08-22)

**증상(실기기 실측)**: 앱이 라이브 데이터를 정확히 그린 뒤, 서버에서 에이전트를 `working` → `blocked`로
바꾸고 워크스페이스를 리네임했는데 **20초가 지나도 화면이 그대로**였다. 원인은 단순했다 —
`HerdrSnapshotProvider`는 마운트당 1회만 로드하고, `reload`는 존재하지만 **호출하는 화면이 0개**였다
(`app/`에 `reload` 참조 0건, `RefreshControl` 0건, 스냅샷 경로에 `setInterval` 0건 `[v]`).

계획은 이미 이걸 지정하고 있었다 — B9: "해소 전까지 v1은 구독 대신 `agent.list` 폴링(포그라운드
3–5초)으로 간다", M2 수용조건 (a): "blocked를 Agents 홈에서 60초 내 발견". 구현이 없었을 뿐이다.

**함정**: `reload()`를 그대로 폴링에 쓸 수 없다. 그 경로는 매 호출마다 `status:'loading'`으로 되돌리고
실패 시 스냅샷을 `EMPTY_SNAPSHOT`으로 비운다 — 4초 폴링이면 매 틱 깜빡이고, 폰에서 일상적인 ssh 끊김
한 번에 멀쩡히 읽히던 화면이 통째로 사라진다. 그래서 **배경 갱신(`refresh`)을 초기 로드와 분리**했다:
`status`를 건드리지 않고, 실패 시 마지막 정상 스냅샷을 유지한 채 `refreshError`만 채운다. 겹침은
`inFlightRef`로 차단 — 바쁜 로더에 도착한 틱은 큐잉되지 않고 증발한다(B8: JSON 호출 1개 = ssh exec 1개).

**리시트**: 유닛 `use-foreground-refresh.test.tsx` 6건(RED-on-revert 확인 — 폴링 무력화 시
`expected 'working' to be 'blocked'`, 즉 기기 증상과 같은 문구로 실패). 기기 실측: 앱을 켜둔 채
22:03:12에 서버를 `ZQ7-POLL-LIVE`+`working`으로 변경 → **22:03:27 화면 반영**(15초). 재시작 없음.

**잔여였던 `refreshError` 미노출은 닫혔다 (2026-08-22).** 두 목록 화면(`app/index.tsx`,
`app/nodes.tsx`) 헤더가 `snapshotStalenessLabel({updatedAt, refreshError})`을 렌더한다. 규칙 셋:
①정상이면 **아무것도 안 그린다**(`ConnectionStatusLine`이 "Connected"를 거부하는 것과 같은 이유)
②`refreshError` 없이 오래된 `updatedAt`도 침묵 — 백그라운드에선 폴러가 멈추므로 나이만으로는
"아무도 안 물어봤다"일 뿐이다 ③15초 미만 침묵 + 초는 5초 그리드(라벨은 실패한 폴마다만 갱신되므로
`stale 43s`는 없는 해상도를 주장하는 것). 새 타이머 없음 — 실패 폴이 이미 4초마다 상태를 쓴다.

**기기 실측 `[v]`**: 랩 ssh 세션을 22:25:35에 끊고 22:26:28 캡처 → 헤더가 **`stale 60s`**, 행 데이터는
마지막 정상값 유지. 그 전 시도에서 라벨이 안 뜬 것은 버그가 아니라 `sshd -D` 마스터만 죽여
**이미 맺힌 연결의 자식 세션이 살아 있었기** 때문이다(계보 `30825 → 30879 → remote-client-bridge`
확인 후 그 체인만 종료). 유닛 13건, RED-on-revert 8건 dispatcher 독립 재현.

---

## H. mx 머지 충돌 — 처리 완료 (2026-08-22)

적발했던 충돌(이 브랜치의 #68 해법 = `just ci` → **`ci-mx`(fmt 우회)** vs 유저의 mx 해법 =
`808b5ca7`로 **트리를 rustfmt**)을 유저 쪽에 맞춰 해소했다.

실행한 것: `origin/mx` 16커밋 머지(충돌은 `docs/next/CHANGELOG.md` 1건 — mx의 Unreleased 항목을
위에, 업스트림에서 온 `[0.8.2]` 릴리즈 절을 아래에 두어 **양쪽 다 보존**) → `lint-no-fmt`·`ci-mx`
**삭제** → ci.yml을 모든 브랜치 `just ci` 단일 스텝으로(단, `branches:`의 `mx`는 유지 = #68이
실제로 필요로 한 부분) → `cargo fmt` (10파일 65줄; 머지가 이미 대부분 정리했다).
Windows 제외(#63)는 별개 결정이라 손대지 않았다.

**머지 후 게이트**: clippy exit 0 · nextest **3981 passed / 0 failed / 1 skipped** ·
`cargo fmt --check` exit 0 (herdr env 벗긴 러너 기준). 섹션 F의 잔존 실패도 이 머지로 사라졌다.

## I. RSA 키 경로 판별 완료 + 재발 방지 게이트 (2026-08-22)

`.prd/06`이 "RSA는 미판별"로 남겨둔 것을 **기기 없이 닫았다** — 실제 sshj 0.40.0에 실키를 먹여
측정했다. 새 게이트 `npm run typecheck:keyformats`가 이 표를 매번 재생산한다 `[v]`:

| 키 (ssh-keygen 생성) | 모듈이 보는 detect | `loadKeys` (현행) | `OpenSSHKeyFile` (구 코드) |
|---|---|---|---|
| ed25519, openssh-key-v1 | `OpenSSHv1` | OK `ssh-ed25519` | **FAIL** |
| **RSA, openssh-key-v1** (7.8+ 기본) | `OpenSSHv1` | OK `ssh-rsa` | **FAIL** |
| RSA, 고전 PEM (`-m PEM`) | `PKCS8` | OK `ssh-rsa` | OK `ssh-rsa` |
| ed25519 + passphrase | `OpenSSHv1` | OK `ssh-ed25519` | **FAIL** |

**결론: 구 버그는 ed25519 전용이 아니었다.** 현대 기본 포맷의 RSA도 똑같이 실패했으므로, 기기에서
RSA 시도가 같은 오류를 낸 것은 오염이 아니라 **정상적인 같은 결함**이었다. 구 코드가 통한 것은
4종 중 고전 PEM 하나뿐이다.

**앞선 내 측정 1건 정정**: 고전 PEM RSA의 detect를 `OpenSSH`로 적었으나 **모듈이 타는 경로에서는
`PKCS8`**이다 — `loadKeys(key, null, finder)`가 null 공개키를 `separatePubKey=false`로 넘기기 때문이고,
`.pub`을 곁들인 프로브는 `OpenSSH`를 보고한다. 버그·수정에는 영향 없고 게이트는 모듈이 실제로 보는
값을 단언한다.

게이트는 **코드를 복사하지 않는다** — `HerdrSshSession.kt`의 키 로드 블록을 awk로 추출한다(기존
하네스가 `HerdrSshConnectConfig`를 다루는 방식). 추출 끝 앵커를 `loadKeys`가 아니라 `authPublickey`로
둔 것이 요점: 수정된 형태에 앵커를 걸면 **버그 형태에서 컴파일조차 안 되어** 게이트가 자기가 지키는
버그를 표현하지 못한다. 구 형태를 되살려 3행 FAIL + exit 1을 dispatcher가 독립 재현했다.

또 APK 실측: `com/hierynomus/asn1`(고전 PEM 파싱 필수)과 `OpenSSHKeyFile`·`OpenSSHKeyV1KeyFile`·
`PKCS8KeyFile`이 모두 들어 있다 → 기기에서 네 포맷 모두의 의존이 갖춰져 있다.

---

## J. 이 머지의 실제 blast radius — "모바일 앱 추가"가 아니다 (2026-08-22, 리뷰가 프레임 정정)

머지 게이트 리뷰에서 dispatcher의 프레임이 틀렸다는 지적이 나왔고, 실측으로 확인했다 `[v]`.

**`origin/mx`에는 upstream v0.8.2가 없다** — `git merge-base --is-ancestor ae8009e1 origin/mx` = NO
(v0.8.0은 in mx, v0.8.2는 NOT). 즉 이 브랜치를 mx에 머지하는 것은 **모바일 앱 + upstream v0.8.2
동기화(133커밋)를 한 번에 착륙시키는 일**이다. 비-mobile diff = **558파일 / +50905 / −7437**
(`src/` 167파일, `website+workers+docs` 273파일). 데스크톱 herdr 사용자에 대한 회귀 위험은
`mobile/`이 아니라 **여기** 있다.

**프로토콜 정체성이 함께 움직인다** `[v]`: mx는 `PROTOCOL_VERSION = 20`이고 `src/protocol/abi.rs`가
**아예 없다**. 이 브랜치는 `21` + `WIRE_ABI_EPOCH = 3` + 28바이트 프렐류드다. 핸드셰이크는 완전일치
검사이므로, 착륙 후 바이너리를 올리는 순간 **서버와 클라이언트가 한꺼번에 움직여야 한다** — 혼재
함대는 붙지 않는다. 이건 결함이 아니라 B1이 의도한 식별 거부(조용한 오파싱보다 낫다)지만, 실사용
함대를 가진 쪽에는 운영 사건이다. 마침 같은 머지가 들여오는 mx 커밋에 **`herdr live-handoff`**
(한 명령으로 모든 러닝 세션을 현재 바이너리로 넘김)가 있으므로 업그레이드 수단은 함께 도착한다.

**따라서 이 머지의 리시트는 "mobile 게이트"가 아니라 upstream 동기화 규약이다.** `update-upstream`
스킬 기준 남은 산출물은 전부 push 이후다: ①`upstream-mirror`를 v0.8.2로 force-push(**머지가 mx에
착륙한 뒤에** — 순서를 어기면 divergence PR diff가 역방향으로 오염된다) ②상시 divergence PR
**#81** 갱신(현재 제목 `divergence: mx vs upstream v0.8.0`, base `upstream-mirror` = `346411fa`
= v0.8.0) ③`mx` push는 `preview-mx.yml`을 격발해 프리릴리즈를 발행하므로 tap·brew까지 완주.

**로컬 리시트가 덮지 못하는 유일한 구멍**: CI 매트릭스에서 `ubuntu-latest`는 nextest `all()`,
`macos-latest`는 `not binary(live_handoff)`다. 나는 macOS에서 `all()`로 돌렸으므로 macOS CI보다는
넓지만 **Linux 레그는 대변하지 못한다** — 그리고 mx tip이 하필 `8fec6568 test(live-handoff): drop an
assertion that is false on Linux`로, 이 영역엔 Linux 특이 파손 전력이 있다. 첫 push의 ubuntu leg는
눈으로 확인해야 한다.

---

## K. 전송 계층 중복 3건 — 1건은 증거유실 버그 (2026-08-22, 동료 세션 제보 + dispatcher 검증)

세 건 모두 `file:line`으로 직접 확인했다 `[v]`. 이 브랜치가 만든 것이 아니라 M4 전송 작업에 이미 있던 것이다.

**K1 (correctness, 최우선) — `mobile/src/transport/observe-stream-link.ts:184` `closeSummary`가
인증 증거를 정확히 그때 버린다.**
공유 `describeClose`(`packages/herdr-client-ts/src/transport.ts:1231`)는 exit·signal·error·stderr를
모두 렌더하는데, 로컬 사본은 `if (close.error) return close.error.message`로 **조기 반환**해 나머지를
버린다. 그리고 원본 close는 `:108`의 `activeToken === token`일 때만 `hooks.reportClosed(close)`로
전달되는데 `activeToken`은 `:132`에서야 설정된다(초기값 `:70` = null) → **Welcome 이전 close에서는
원본이 아예 전달되지 않고** 손실된 문자열만 남는다.
결과: `{error: Error('channel closed'), stderr: 'Permission denied (publickey)'}`가
`'channel closed'`로 납작해져 일반 transport 실패로 분류되고 **영원히 재시도한다** — latch해야 할
인증 실패인데. 이 세션 내내 다룬 "실패가 성공/일시장애처럼 보이는" 부류의 전송판이다.
→ 공유 `describeClose`를 쓰고, pre-Welcome close도 원본을 분류기까지 보낸다.

**K2 (wire 불변식) — `mobile/src/transport/client-ping.ts:30,33` 이 Ping/Pong 태그를 하드코딩한다.**
`CLIENT_MESSAGE_PING_TAG = 10` / `SERVER_MESSAGE_PONG_TAG = 10` + 로컬 `encodePing`이
공유 홈(`constants.ts`의 `ClientMessageTag`/`SERVER_MESSAGE_VARIANT_NAMES`, `messages.ts`의 인코더)
**밖**에 있다. `constants.ts`의 "wire 변경은 이 파일 한 곳" 불변식 위반이다. ABI epoch/레이아웃이
움직여 Ping/Pong 태그가 이동하면 패키지와 서버는 갱신되는데 이 파일은 **여전히 컴파일되고 로컬
테스트도 green**이다 → 워치독이 엉뚱한 variant를 보내거나 무관한 tag 10을 Pong으로 인식해
멀쩡한 링크를 흔들거나 죽은 링크를 가린다. 우리는 방금 `WIRE_ABI_EPOCH`를 3으로 올린 참이다.
→ 태그와 `encodePing`을 `@herdr/client-ts`로 옮긴다.

**K3 (중복, 저위험) — `mobile/src/transport/channel-failure.ts:122` `describe`는 스스로 사본임을
주석에 밝히고 있다.** 분류 분기 `:99/:108/:115/:118`이 전부 이걸 쓴다. 공유 쪽에 redaction이나
필드가 추가되면 두 번 고쳐야 하고, 안 고치면 같은 close에 대해 분류기와 코덱의 진단이 갈린다.
→ `describeClose('closed', close)` 호출로 대체. **주의**: 공유 함수는 `prefix (parts)` 형태이고
로컬은 `parts`만 반환하므로 렌더 문자열이 바뀐다 — 이걸 단언하는 테스트를 함께 갱신해야 한다.

---

## L. 동료 세션 제보 — 독립 리뷰 7건, 전부 dispatcher가 file:line 재검증 (2026-08-22, 고정 커밋 54308ff)

같은 커밋에 대한 외부 세션들의 CONFIRMED 투표. **inputs not oracles** 원칙대로 전부 직접 열어 확인했고,
아래는 내 검증 결과다(peer 주장 그대로가 아니다).

### L0 — 인증 증거 유실은 1건이 아니라 **5층 사슬**이다 `[v]`

`.prd/09` §K가 이 중 2층만 봤다. 전체는 이렇다. 각 층이 독립적으로 증거를 지운다:

| 층 | 위치 | 무엇이 사라지나 |
|---|---|---|
| 1 | `modules/herdr-ssh/android/.../HerdrSshSession.kt:253-257` | `pumpStdout`이 EOF에서 `finish()`를 부르고, `finish()`가 `pumps.shutdownNow()`로 **동시 실행 중인 stderr 펌프를 중단**시킨 뒤 스냅샷 → stderr **절단**. 그리고 `exitStatus`/`exitSignal`은 별도 채널 요청이라 close 대기 없이 읽으면 **null**일 수 있다 |
| 2 | `src/transport/observe-stream-link.ts:190-192` | `if (close.error) return close.error.message` 조기 반환이 exit/signal/stderr 폐기 |
| 3 | 같은 파일 `:108-111` | `activeToken`(`:70` null, `:132` 할당) 때문에 **pre-Welcome close는 원본이 전달되지 않음** |
| 4 | `src/transport/connection-supervisor.ts:303-312` | dial rejection이 **`{ error }` 단일 필드**로 close를 합성 |
| 5 | `src/transport/channel-failure.ts:104,110` | `auth`(fatal, `permission denied`/`publickey`)와 `missing-binary`(**`close.exitCode === 127` 필드 참조**)가 볼 것이 없어 `{kind:'transport', fatal:false}`로 낙하 → **영원히 재시도** |

거부된 키를 다시 들이미는 것은 아무것도 바꾸지 않으므로 latch가 정답인데, 5층 중 어디 하나만 고쳐도
나머지가 여전히 지운다. **1층을 안 고치면 위층 보존은 보존할 것이 없다.**

### L1 — ssh 재다이얼 경로가 앱 수명 내내 없다 `[v]` (§I의 목업 폴백은 **증상**이었다)

`useHerdrSshConnections`는 `useEffect(…, [])`에서 **한 번만** 다이얼한다(`app-connections.ts:135-154`).
실패한 원격은 `connections`에 들어가지 않고(`:105-118`), `useSupervisedRemotes`는 **성공한 배열로만**
supervisor를 만든다(`:45-63`) → 실패한 원격에는 타이머도, `forceReconnect` 대상도, foreground nudge
대상도 없다. 그리고 supervisor의 재시도는 **이미 맺힌 ssh 위에 새 exec 채널을 여는 것뿐**이다 —
`observe-stream-link.ts:53-63`의 주석이 스스로 그렇게 못박고 있다: *"it cannot recover a dead ssh
connection, which needs a dialer one level down"*.
**결론: 시작 시 실패했거나 도중에 죽은 ssh는 앱을 재시작해야만 살아난다.** 내가 §I에서 고치라고
디스패치한 "목업 대신 에러"는 옳지만 증상 처치이고, 원인은 이쪽이다. 별도 단위로 남긴다.

### L2 — pane 스트림 사망에 복구가 없고, 화면은 "Connected"라고 말한다 `[v]`

`PaneObserver`의 채널 close는 로컬 status만 closed로 바꾸고(`src/session/pane-observer.ts:177-182`),
`usePaneObserver`는 `[connection, handleRef, hasPane]` 변화에만 재생성하며 close/retry 경로가 없다
(`use-pane-observer.ts:73-122`). 프로덕션 supervisor는 **별개의 health 스트림**을 감시하므로
(`use-supervised-remotes.ts:51-61`), pane exec 채널만 죽으면 health 링크는 멀쩡하다 →
**마지막 프레임을 든 채 "stream ended" + "Connected"가 동시에 표시**되고 리마운트 전까지 복구 없음.
`SupervisedRemote.observe`는 레지스트리/replay API가 있는데도 테스트에서만 쓰인다.

### L3 — `retarget` 경쟁으로 스트림과 입력이 서로 다른 pane을 가리킬 수 있다 `[v]`

`usePaneObserver:69`가 `void observer.retarget(paneId)`를 직렬화 없이 쏜다. B·C 두 호출이 target=A인
채로 통과한 뒤 각자 `pane.layout`을 await하고, `pane-observer.ts:249`의 사후 가드는 disposed/채널
동일성만 본다 → C가 먼저 끝나고 **늦은 B가 마지막에 `target=B`(:252) + `RetargetTerminal(B)`**를 보낼
수 있다. `PaneViewerScreen`은 입력을 라우트에서 따로 유도하므로(`pane/[paneId].tsx:154-163`)
**입력은 C, 화면은 B**가 된다. 기존 테스트는 retarget을 직렬 await하거나 라우트를 한 번만 바꾼다.

### L4 — WebView reload 후 터미널이 영구 백지 `[v]`

`TerminalWebView.tsx:214-224`가 pending/coalesced를 비우고 reload하는데, web-ready 경로는
`onWebReady`/theme/flush만 부르고(`:105-117`) 유일한 부모 콜백은 **NOOP**이다
(`app/h/[remoteId]/pane/[paneId].tsx:241`). 그 사이 `PaneObserver`는 살아서 프레임을 계속 받고
sink는 opened로 남아(`:317-320`, reset은 retarget 때만 `:254`) **`RequestFullFrame`이 나가지 않는다**
(`terminal-frame-sink.ts:129-138`은 reset/unopened sink가 diff를 볼 때만 발화).
결과: 새 document에 init/term이 없고 이후 diff는 큐잉됐다 flush되지만
`terminal-webview-html.ts:657-660`이 ready+term 없이는 펌프를 거부한다.

### L5 — 원격 바이너리 설치에 **체크섬 검증이 없다** `[v]` (herdr 코어, 보안)

`src/remote/attach.rs`가 자산 URL만 역직렬화하고(`:704-718`) 받은 바이트를 **검증 없이**
(`:2012-2031`) ssh로 스트리밍해 원자적으로 설치한다(`:2096-2149`). 설치 후 검사(`:880-887`,
`:1010-1086`)는 설치된 바이너리를 실행해 **자기 보고** 버전/프로토콜을 묻는 것이라 무결성 검증이 아니다.
대조: `src/update.rs`는 매니페스트 체크섬을 **요구**하고(`:407-429`) `verify_sha256`으로 검증한다
(`:623-664`). `sha256` 문자열 출현 수 = update.rs **36** vs attach.rs **2**.
그리고 이 포크는 upstream v0.8.2의 sha256 자산 맵을 **의도적으로 머지하지 않았다** —
`attach.rs:3936-3938` 주석이 그렇게 적고 있다(소비자인 `resolve_release_asset`을 포크가 자체 시딩
경로로 대체했기 때문). TLS는 전송/매니페스트 호스트만 지키므로, **신뢰된 매니페스트를 받은 뒤 자산
스토어가 교체되는 시나리오**를 막지 못한다.
**이건 모바일이 아니라 herdr 코어이고, 이 머지가 `attach.rs`를 +4484줄 들여온다.** 머지 차단 사유로
올릴지는 유저 판단이지만, 원격에 바이너리를 심는 경로라 등급이 높다.

**처리 상태**: L0의 1층·2~4층은 각각 별도 단위로 수정 위임됨. L1·L2·L3·L4·L5는 **미착수 큐**.

---

---

**규율**: 이 목록은 *n번째 문서화*가 아니라 **추적 큐**다. 항목을 닫을 때는 여기서 지우고 커밋 메시지에 근거를 남긴다.

## M. §K1·K3 + AbiMismatch — 닫힘 (2026-08-22, 커밋 `d8d36bb5`)

증거 유실 사슬은 §K에 적었던 2층이 아니라 **5층**이었다. 그중 2~4층이 닫혔다.

| 층 | 위치 | 상태 |
|---|---|---|
| 1 | `HerdrSshSession.kt:253-257` — `shutdownNow()`가 배수 중 stderr 펌프를 끊고, 채널 close 전에 `exitStatus`를 읽는다 | **열림** (위임 중) |
| 2 | `observe-stream-link.ts` — pre-Welcome close에서 `close.error?.message`만 남기고 exit/signal/stderr 폐기 | 닫힘 — 구조체째 `hooks.reportClosed(close)` |
| 3 | 같은 파일 — `activeToken`이 핸드셰이크 후에야 설정돼, pre-Welcome close에 **보고할 주체가 없었다** | 닫힘 — `dialToken`(다이얼 시작 시 청구) / `activeToken`(핸드셰이크 후) 분리 |
| 4 | `connection-supervisor.ts:303-312` — 거부된 다이얼을 `{ error }` 단일 필드로 재합성 | 닫힘 — `closeOfDialRejection(error)` |
| 5 | `channel-failure.ts` — `AbiMismatchError`가 fatal 분기에 없어 무한 재접속 | 닫힘 — `protocol/fatal` + `WIRE_ABI_HINT` + `describeAbiRefusal` |

5층은 이 브랜치가 자초한 구멍이었다: M0가 `WIRE_ABI_EPOCH`와 프렐류드를 만들어 서버에 "낯선 레이아웃을 거부하라"를 가르쳤으나, 클라이언트에는 **그 거부가 복구 불가능하다**는 것을 가르치지 않았다. `grep -rn AbiMismatch mobile/` = 0건이었다.

RED-on-revert 3종 독립 재현(2층·4층·경합 가드). 게이트 72파일/650테스트, typecheck·lint·format:check exit 0.

### 잔여 — 같은 모양의 **네 번째 사본**

`mobile/test/live/paneViewerOutage.live.test.tsx:282-286`의 `sshRedialLink` 팩토리가 `close.error?.message` + 핸드셰이크-후 `activeToken` 게이트를 동일하게 갖고 있다. 결과: **실제 sshd에 다이얼하는 유일한 리시트가 구조적으로 이 수정을 관측할 수 없다.** "나쁜 키가 latch된다"를 종단으로 증명하려면 여기부터다.

그리고 이 사슬 전체는 Android transport가 실제로 `stderr`/`exitCode`를 채워야 폰에서 발화한다 (`ssh-transport.ts:42`의 "부재 = undefined" 규약, `packages/herdr-client-ts/src/transport.ts:184-186`).

## N. 무체크섬 원격 설치 — 귀속 재측정 (2026-08-22)

패널 1인이 `attach.rs`의 release-asset 무검증 설치를 **머지 차단**으로 들었다. 귀속을 직접 쟀다:

| 측정 | 값 |
|---|---|
| `git show origin/mx:src/remote/unix.rs \| grep -ci sha256` | **0** |
| `git show feat/mobile-client:src/remote/attach.rs \| grep -ci sha256` | 2 (검증에 쓰이지 않는 잔재) |
| 대조군 `src/update.rs` (자가 업데이트 경로) | origin/mx **20** / branch **36** |
| `origin/mx:src/remote/unix.rs:1946` | `fn download_release_asset` 존재 |

upstream v0.8.2가 `unix.rs`를 `attach.rs`로 재편했을 뿐, **무체크섬 원격 설치 경로는 mx에 이미 있었다.**

### 정정 — 위 측정은 baseline이 틀렸다 (2026-08-22, 합성 패널이 지적, dispatcher 재측정)

`origin/mx` 직전 상태를 zero로 잡으면 "upstream이 줬는데 우리가 버린 것"이 **구조적으로 관측 불가능**하다. 올바른 zero는 이 머지 자신의 계약(mx ∪ upstream)이다. 그 계기로 재니 판정이 뒤집힌다:

| 측정 | 값 |
|---|---|
| `git show ae8009e1^2:src/remote/attach.rs \| grep -ci sha256` (upstream 부모) | **22** |
| 그중 `:1447` | `crate::checksum::verify_sha256(&path, expected)` — **실호출** |
| `git show ae8009e1:src/remote/attach.rs \| grep -ci sha256` (머지 결과) | **2** — 테스트 픽스처 JSON + 주석뿐 |
| `struct RemoteUpdateManifest` (`attach.rs:704-711`) | `sha256` 필드 **없음** → 매니페스트의 체크섬 맵이 역직렬화에서 증발 |
| `attach.rs:3915-3938` | 그 증발을 **테스트가 고정한다** — `"sha256": {...}`를 포함한 매니페스트를 먹이고, 주석이 "upstream v0.8.2's `sha256` asset-checksum map is not merged … See DIVERGENCE.md" |

⇒ **upstream v0.8.2는 이 결함의 수정본을 들고 왔고, 이 머지가 그것을 의도적으로 반려했다.** 귀속은 "기존 부채"도 "새 회귀"도 아닌 제3범주 — **머지-귀속 손실**이다.

**합성 패널의 한 주장은 틀렸다**: `src/checksum.rs`는 머지를 넘어왔다 (`ae8009e1^2`·`ae8009e1`·`feat/mobile-client`·`origin/mx` 전부 존재). 사라진 것은 모듈이 아니라 **원격 설치 경로의 호출부**다. 자가 업데이트(`src/update.rs:657,740`)는 여전히 `verify_sha256`을 부른다. 즉 결함의 본체는 **자가 업데이트는 검증하는데 원격 설치는 안 하는 비대칭**이고, 복원 비용은 모듈 신설이 아니라 필드+호출부다.

### 그런데 진짜 위험은 결함이 아니라 안치 장소다

`DIVERGENCE.md:70-73`이 sha256 맵을 #355 keepalive 이연과 **같은 불릿**에 넣고 이렇게 끝난다 — 그 항목들을 `#[allow(dead_code)]` 뒤에 유지하는 이유는 "**so the next merge stays quiet here**". DIVERGENCE.md의 의미론은 "숙고 끝에 수용한 분기"이고, 저 문장은 그 파일이 **다음 머지에서 신호를 끄도록 설계**됐음을 명시한다. **보안 통제를 그 원장에 넣으면 다시 검토되지 않는다.**

→ 조치 순서: ①`DIVERGENCE.md:70-73`에서 sha256 항목을 **빼내 오너 있는 이슈로 재기표** ②그다음 `RemoteUpdateManifest.sha256` 필드 + `resolve_release_asset` 호출부 복원(upstream이 이미 쓴 코드). 순서가 이렇다 — 원장에 남는 한 다음 머지에서도 안 보인다.

### 그래도 차단이 아닌 이유

차단은 노출을 **1도 줄이지 않는다**. mx는 이미 바이트 동일한 무체크섬 경로를 배포 중이고(`origin/mx:src/remote/unix.rs:1946` ↔ `attach.rs:1951`, 유일한 차이는 `private_download_dir` base가 `std::env::temp_dir()`→`remote_private_temp_base()`로 **강화**된 것), 머지를 거절하면 노출은 그대로인 채 모바일 작업과 upstream 133커밋(그 강화 포함)을 잃는다. 노출 조건도 좁다: `channel != "stable"`이면 다운로드 전 Err, 번들 페이로드나 `HERDR_REMOTE_BINARY`가 있으면 Download 티어 미도달, TLS가 전송을 덮으므로 남는 위협은 릴리즈 자산/오리진 치환.

## O. 세대 격리 실패 — 라운드 3 리뷰가 낸 차단 결함 (2026-08-22)

외부 패널 1인이 라운드 3에서 낸 것. dispatcher가 `file:line`으로 재구성해 확인했다. **mx 기존 부채가 아니라 이 브랜치가 들여오는 supervisor의 결함이다.**

### 결함 1 — 폐기된 세대가 현재 세대의 liveness를 죽인다

```
1. Gen A 다이얼 → observe-stream-link.ts:88  dialToken = A
2. supervisor가 stale dial 폐기 (connection-supervisor.ts:225-239)
   → :218-224 주석이 자인: pending dial은 promise일 뿐이라 this.link === null,
     닫을 객체가 없다. 세대만 교체된다.
3. Gen B 핸드셰이크 성공 → :171 activeToken = B. 정상 연결.
4. Gen A의 늦은 Welcome → onMessage(:99-115)에 세대 검사 없음 → A의 handshake 해소
   → :171 activeToken = token   ← 가드 없이 A로 덮어쓴다
5. A의 promise → connection-supervisor.ts:302-305가 stale로 보고 link.terminate()
   → terminate가 activeToken을 null로
6. Gen B의 probe()(:176-178) → activeToken !== token → 영구 false
   → 워치독이 침묵으로 읽고 멀쩡한 연결을 죽인다
```

4단계만으로 이미 B가 깨진다. 5단계는 null로 만들 뿐이다.

**커버리지 비대칭이 원인**: `onClose`(`:126-133`)에는 `dialToken !== token` 가드가 있는데(커밋 `d8d36bb5`가 넣은 것) `onMessage`·`onUndecodable`·핸드셰이크 후 상태 변경에는 없다. §M이 close 경로만 닫고 welcome 경로를 남겼다.

### 결함 2 — 응답 없는 dial의 exec 채널이 고아가 된다

`channel = opened`(`:154`)는 공유 변수이고 새 dial이 덮는다. 폐기된 dial의 `opened`는 그 클로저에서만 도달 가능한데, peer가 Welcome도 close도 안 보내면 `await handshake`가 영원히 안 풀려 **`SupervisedLink`를 반환하지 못한다** → 아무도 `terminate()`를 못 부른다 → `opened.close()`가 절대 안 불린다. supervisor도 `this.link === null`이라 못 닫는다.

foreground 부활마다 exec 채널 + 원격 `herdr` bridge 프로세스가 누적된다. B8(1 JSON = 1 ssh exec = 1 원격 프로세스)이 이미 압박받는 자원이다.

### 이것이 주는 교훈

`proxy-green` — close-evidence 테스트가 green이어도 pending dial의 **자원 소유권과 세대 격리**를 검증하지 않으면 연결 수명주기는 green이 아니다. 기존 테스트 `cannot latch the generation that replaced it`은 **close 경로의 세대 격리만** 증명한다. welcome 경로는 무증명이었다.


## P. 가로 메트릭 불일치 — 213컬럼 중 마지막 7~9열에 도달 불가 (2026-08-23, QA 실측)

M2 (e) 재판정 중 별도 QA 에이전트가 실측. **(e)는 PASS했다** — 커서 행과 최신 출력은 최대 줌에서
선명하게 도달 가능하다. 그러나 **그리드 최우단 7~9컬럼은 어떤 배율에서도 화면에 못 올라온다.**

**실측**: 마커 `196:>>>>>>>>>>>>:213`(col 194–213)을 심고 최대 줌 + 최대 우측 팬에서 보이는 것은
`196:>>>>>>>>>`(col ~206)까지. fit에서도 동일하게 잘린다.

**원인** — 가로 전용 메트릭 불일치:

| | 값 |
|---|---|
| `getContentWidth()` = `cellW × cols` | **1630 CSS** |
| 실제 도색 폭 | **~1700 CSS** |
| 화면 실측 컬럼 advance | 7.98 CSS |
| xterm이 element 크기 산정에 쓴 값 | 1630/213 = **7.653** |
| 세로 (대조군) | 도색 행간 15.25 vs element 15.235 — **일치** |

`clampPan`이 1630을 기준으로 클램프하므로 나머지 ~70 CSS가 영원히 뷰포트 밖에 남는다.

**회귀가 아니다** [QA 실측]: `284c0558^`의 `computeFitScale`도 이미 `cellW * term.cols`를 썼고(pre-commit
line 359), 커밋이 교체한 `clampPan`의 구값 `term.element.scrollWidth`도 현재 DOM에서 **1630으로 동일 측정**
된다. 커밋 전후 클램프 산술이 같다. 즉 핀치 수리가 만든 결함이 아니라 그 수리가 **드러낸** 선행 결함이다.

**미확인**: 에뮬레이터 한정인지. 실기기 폰트(`SF Mono` 부재 → 대체 폰트)에서도 같은 크기의 불일치인지
확인 안 됨. 수리 전에 그것부터 재는 게 맞다 — 폰트 의존이면 `cellW` 산출 자체를 도색 실측으로 바꿔야 한다.

### §P 원인 규명 + 수리 (커밋 `ccbaafe4`)

**왜 가로만 어긋나는가** — xterm 소스(`@xterm/xterm` 6.1.0-beta.285)에서 확인:

| | 메커니즘 |
|---|---|
| **세로** | `DomRenderer.ts:152-154`가 매 행 element에 `style.width`/`height`/`lineHeight`를 **써 넣는다.** DOM이 따를 수밖에 없다 → 15.25 vs 15.235 일치는 구조적이다 |
| **가로** | 컬럼당 advance를 강제하는 CSS가 **없다.** xterm의 유일한 레버는 `letter-spacing`이고 `DomRenderer.ts:323-328`이 `css.cell.width − widthCache.get('W')`로 계산하는데 **양쪽 다 캔버스 `measureText`**다 |

⇒ **캔버스 폰트 해석과 레이아웃 엔진 폰트 해석이 갈리면 그 편차가 보정식에서 상쇄돼 사라지고 도색에 그대로 남는다.**
Android엔 `SF Mono`/`Menlo`/`Monaco`가 하나도 없고 `monospace` 폴백만 잡히는데, 캔버스 2D의 폴백 경로와
레이아웃 엔진의 폴백 경로가 같다는 보장이 없다. 편차가 항상 "측정값 < 실제 advance" 쪽으로만 누적되므로
잘리는 쪽은 언제나 오른쪽 끝이다.

**산술 대조**: `round(7.6526 × 213) = 1630` — QA 실측과 정확히 일치하고 dpr에 의존하지 않는다(DOM 렌더러
식에서 dpr이 상쇄된다).

**수리**: 하드코딩 보정 금지. 프로브가 `.xterm-rows`의 computed 폰트를 **`letterSpacing`까지 상속한** span
64×'W'로 실제 도색 폭을 재고 `Math.max(cellW, painted)`를 쓴다. 보정이 제대로 도는 기기에선 프로브가
`css.cell.width`와 **정확히 같은 값**을 돌려주므로 자기교정이다 — 폰트가 바뀌어도 반대로 틀리지 않는다.

### ⚠️ 다음 QA가 **가장 먼저** 확인할 것

```js
document.querySelector('.xterm-rows') !== null
```

**null이면 WebGL 렌더러가 그리고 있고 이 수리는 무동작이며 §P의 원인이 위 설명과 다르다.**
에뮬레이터에서 이 값이 무엇이었는지 **아무도 기록하지 않았다.** 이게 이 절의 load-bearing 미지수다.

그리고 판별 못 한 것 하나: **도색이 실제로 1700까지 갔는지 vs 1630에서 잘렸는지**를 스크린샷 없이 구별할
수 없다. 후자라면 팬 클램프가 아니라 xterm의 레이아웃 폭 자체를 늘려야 하고 그건 다른 수정이다.
판별점 = 마커 `196:>>>>>>>>>>>>:213`을 다시 심고 ①fit에서 213열 전부 들어오는지 ②최대 줌+최대 우측 팬에서
`:213`까지 도달하는지.

#### 정적 조사로 좁힌 것 (2026-08-23, 기기 없이)

WebGL 애드온은 **실제로 로드된다** — `terminal-webview-html.ts:777`의 `attachWebglAddon(true)`,
빌드 소스도 `@xterm/addon-webgl`를 번들한다(`scripts/build-terminal-webview-engine.mjs:15`).
그리고 프로브는 그 경우 **0을 반환하도록 의도돼 있다** (`terminal-webview-painted-cell-injected.ts:54-56`,
근거는 같은 파일 헤더 `:19-21`: *WebGL은 `css.cell.width`로 캔버스를 잡으므로 그 값이 곧 도색이고,
`.xterm-rows`는 DOM 렌더러가 처분돼 존재하지 않는다*).

**그래서 갈림이 두 갈래로 좁혀진다 — 코드로는 더 못 좁힌다:**

| 기기에서 `.xterm-rows`가 | 뜻 |
|---|---|
| **존재** (WebGL 컨텍스트 생성 실패 → DOM 렌더러) | §P의 위 설명이 성립하고 `ccbaafe4`가 실제로 동작한다 |
| **null** (WebGL 활성) | `ccbaafe4`는 **설계상 무동작**이고, 그렇다면 캔버스가 `css.cell.width`로 잡히므로 9열 격차가 *애초에 생기면 안 된다* → **관측된 증상의 원인이 §P의 설명과 다르다** |

즉 이 한 줄이 "수리가 동작하는가"와 "진단이 맞았는가"를 **동시에** 가른다. 다음 실기기 QA는 다른 무엇보다
먼저 이걸 찍어라.

### §P2 — 같은 불일치가 탭·선택 좌표도 오염시킨다 (미수정)

`terminal-webview-html.ts:1169-1177`이 `col = Math.floor(sx / getCellWidth())`,
`:1431-1435`가 선택 오버레이를 `col * getCellWidth()`로 계산한다. advance 7.98을 7.653으로 나누면
**213열 끝에서 약 9열 어긋난다** — 오른쪽으로 갈수록 탭이 왼쪽 셀에 떨어지고 선택 하이라이트가 글자와
어긋난다. §P(도달 가능성) 스코프 밖이라 미수정. 같은 기기 세션에서 화면 오른쪽 절반의 URL 탭·드래그 선택을
검증하면 실재 여부가 드러난다.


## Q. observe 스트림이 끊긴 뒤 화면을 열어둔 채로는 재부착되지 않는다 (2026-08-23, M3 QA 실측)

M3 QA 중 별도 에이전트가 라이브로 관측. **M3 판정에는 영향 없다** — 그 동안에도 입력은 정상 배달됐다
(스트림이 죽은 상태에서 탭한 `y`가 서버에서 실행됨). **이건 observe 재부착 생명주기 결함이다.**

**서버 로그 타임라인 (실측)**:
```
20:14:43Z  observe client 41 끊김
20:15:11Z  FullApp client 81 재연결          ← transport는 재다이얼됐다 (M4 ssh redial 동작)
           …2분 넘게 terminal observe 없음…
20:17:27Z  terminal observe client connected  ← 내가 화면을 나갔다 다시 들어간 시점
```

즉 **transport 층은 복구되는데 observe 구독이 따라오지 않는다.** 사용자 입장에서는 pane 화면이
열려 있는데 화면만 얼어붙고, 재마운트(나갔다 들어오기)로만 살아난다.

**이건 이미 지목된 갭의 라이브 확증이다** — 트리니티 패널이 §L2/책사 ③으로 올린
"`SupervisedRemote.observe()`가 선언만 있고 production 호출자 0" 그것이다. 그때는 코드 읽기였고
이번엔 실측이다.

**미규명**: 끊긴 원인. logcat에 `[net] network changed … cameOnline:false`가 있으나 인과 미확정.
에뮬레이터 한정일 수 있다.

**우선순위**: 이게 M4의 "됐다"(기내모드 ×10 / Wi-Fi↔셀룰러 ×10 자동 복구)를 직접 위협한다.
M4 실기기 검증 **전에** 고쳐야 그 검증이 의미를 갖는다.


## R. iOS 첫 QA — M2 FAIL, M2b 판정 불가 (2026-08-23, 별도 에이전트, 커밋 `5b4f33ad`)

iOS가 처음 QA받았고 **Android엔 없던 결함 2건**이 나왔다. 그게 이 QA의 값어치다.

| M2 | 판정 |
|---|---|
| (a) blocked 60초 내 발견 | **FAIL** — 화면 `0 nodes` + `the ssh channel is no longer open` |
| (b) pane 읽기 | **FAIL** — (a)에 막힘 |
| (c) 30분 무변화 | 판정 불가 — 볼 라이브 pane이 없었다 (실관측 0분) |
| (d) 백그라운드 10왕복 | **PASS** — `app.state`가 한 번도 notRunning 아님 |
| (e) 넓은 pane 도달 | 판정 불가 |

M2b ①②③ **전부 판정 불가** — 아래 서명 게이트.

### D2 — ssh 채널 write 레이스 (M2 FAIL의 단일 원인)

**연결은 성립했고 UI 렌더가 실패했다.** 와이어 실측:
```
ssh ed25519 인증 OK
← {"method":"remote.list"}     (49B) → 59B
← {"method":"workspace.list"}  (52B) → 312B 라이브
  ("label":"qa-ios-lab","agent_status":"blocked","pane_count":3)
그 다음 채널 ← stdin 0바이트로 열렸다 닫힘
```
근인(코드 레벨): `HerdrSshSession.swift`의 `attach()`가 `Task { client.withExec { … self.writer = outbound … } }`를
띄우고 **즉시 `return true`**. `write()`는 `guard let outbound else { throw .channelGone }`.
**attach가 true를 준 뒤 클로저가 `writer`를 대입하기 전 창**에 write가 들어오면 무조건 실패한다.

**Android가 안 그런 이유가 계약의 갈림점이다** — `session.exec(command)`가 **동기로** 채널을 만들고
그 다음에야 반환한다. Citadel의 `withExec`는 클로저 기반이라 그 순서가 보장되지 않는다.

화면 문구 `the ssh channel is no longer open`은 레포 전체에서 **이 iOS 파일에만** 있어서 경로를 특정한다.
§Q(observe 재부착)와 **다른 지점**이다 — 이건 다이얼 시점의 요청/응답 API 채널이다.

### D1 — 상단바가 top safe-area inset을 무시 (세로에서 `settings` 도달 불가)

`settings` 버튼 프레임 `{{314.3, 31.7},{71.7, 14.3}}`, iPhone 17 Pro 상단 inset ≈ **59pt**
→ 버튼 전체가 상태바/Dynamic Island 아래. 탭은 전달되나 내비게이션 0.
**가로로 돌리면(상태바 숨김) 같은 탭이 성공** — 격리 확인.

근인: `app/index.tsx:119` `appbar: { … paddingTop: 24 }` 하드코딩. **24는 Android 상태바 높이**라
Android에서 우연히 맞아 이 클래스가 안 잡혔다. 상단바 어디에도 `useSafeAreaInsets()`가 없다
(인셋 사용처는 `RightDrawer.tsx:94`, `mounted-bottom-drawer.tsx:80` 둘뿐).

### D3 — 내 브리프가 틀렸다

expo-notifications 에러의 원인은 `aps-environment` 미설정이 **아니라** 같은 키체인 엔타이틀먼트 부재다.
제품 결함 아님.

### ⛔ M2b iOS QA의 선행 게이트 — 코드사이닝 아이덴티티

이 머신에 **코드사이닝 아이덴티티가 0개**다 → 시뮬레이터 앱 엔타이틀먼트가 비어 있음 → 키체인 사용 불가
→ `expo-secure-store`가 아예 안 돈다 → 키를 한 번도 저장 못 함 → **`purgeIfFreshInstall()`이 지울 대상이
없어 purge 경로 미검증.**

**iOS는 그 코드가 실제로 필요한 유일한 플랫폼**인데(Android는 앱 삭제 시 secure-store가 원래 사라진다)
그 시험을 못 했다. 수동 재서명 2회 시도는 컨테이너화가 깨져 앱이 안 떴다(`containerization was prevented`).

→ **유저 액션: 서명 아이덴티티 확보.** 이게 M2b iOS QA의 선행이다.

### ✅ 긍정적 발견 — iOS는 화면이 텍스트로 읽힌다

**RN Fabric이 iOS에선 접근성 트리에 텍스트를 올린다.** XCUITest `debugDescription`으로 화면 전체를
텍스트로 읽었다. Android `uiautomator`가 텍스트 노드 0개인 것과 **정반대**다.
→ iOS QA는 비전이 아니라 **텍스트 판독이 정본**이 될 수 있다.

## S. D2의 다음 균열 — exec 승인에 상한이 없었다 (2026-08-23, 커밋 `b411ef04`)

`25e54ae8`가 iOS `attach()`를 **채널이 쓸 수 있을 때까지 기다리게** 만든 것은 옳은 수리였고, 그 수리가
문을 하나 열었다. PRINCIPLES §4("첫 수리를 내보내기 전에 다음 균열을 찾아라")를 D2에 적용한 결과다.

| 층 | exec 승인 대기가 묶이나 |
|---|---|
| Android | **묶인다** — `HerdrSshSession.kt:100-101`이 `client.timeout = connectTimeoutMs`(20s), `session.exec`가 그 아래 future를 기다린다 |
| iOS | **안 묶인다** — Citadel은 채널 *개설*만 15초로 재고(`TTY.swift:311-313`) `ExecRequest(wantReply:true)` 응답엔 타이머가 없다 |
| TS | 안 묶였다 — `ssh-transport.ts`의 `openChannel`이 무기한 await |

증상: 원격이 TCP는 받아주고 exec에 영영 답하지 않으면 **iOS 다이얼이 영구히 매달린다.** 화면엔 아무것도 없다.
D2 이전엔 즉시 반환이라 매달릴 것이 없었으므로 **이 위험은 D2가 도달 가능하게 만든 것**이다.

### 수리 위치가 네이티브가 아닌 이유

TS 이음매(`awaitExecAck`)에 뒀다 — ①한 곳이 두 플랫폼을 덮는다(Swift·Kotlin 두 벌은 갈라진다)
②**vitest로 증명된다**(네이티브 하네스는 못 한다). 예산은 새 키가 아니라 `ssh.connectTimeoutMs` —
Android exec이 이미 정확히 그 값 아래 도는 것이 그 선택의 근거다.

### 통지를 빼는 데 한 라운드가 더 걸렸다 — 그리고 그게 실질이었다

첫 구현은 데드라인에서 `finish({error})`를 불러 `handlers.onClose`도 보냈다. 게이트는 전부 green이었다.
**무해해 보이지만 아니다**:

```
데드라인 → onClose → PaneObserver.onClose (generation 가드 통과)
                     → streamDown() → attachSeq+1, ladder.arm()   ← attempt 1회
        → reject  → catch → fail()   ← fail()에는 generation 가드가 없다 (`pane-observer.ts:479-482`)
                     → streamDown() 두 번째                        ← attempt 2회째
```

타이머는 하나다(`reconnect-policy.ts:107`의 `schedule()`이 `cancel()`을 먼저 부른다). 그러나
`this.attempt`가 **두 번 전진**한다 — L3의 캡과 트리클이 둘 다 이 카운터를 읽는다.
`pane-observer.ts:393-397`의 주석이 정확히 이 사고를 경고하고 있었다.

**기존 경로엔 이 문제가 없다는 것이 결정적 판별이었다**: pre-ack 클로즈(`test/ssh-transport.test.ts:150`이
고정한 모양)에서는 `openChannel`이 **resolve**하고 `:291`의 `generation !== this.attachSeq` 가드가
두 번째 패스를 잡는다. **rejection만 그 가드를 우회한다.** 즉 "기존과 같은 모양"이 아니라 새 조합이다.

→ `NativeChannel.discard()` — `closed`(늦게 온 native를 `bind`가 닫게 하는 플래그)와 live 셋 제거는
유지하되 **통지는 안 한다.** 호출자는 채널 객체를 받은 적조차 없으므로 rejection이 유일한 신호다.

### 잔여 (고치지 않음)

1. **`redialable-transport.ts:87-94`가 이 rejection을 그대로 위로 던진다.** 재다이얼 정책이 이 **새 실패
   모드**를 어떻게 취급하는지 **아무도 읽지 않았다.** 데드라인 만료가 재다이얼을 유발해야 하는지
   (연결은 살아있고 exec만 안 오는 상태다) 아니면 채널 단위 재시도여야 하는지가 미결.
2. **네이티브 요청 자체는 여전히 매달린다.** TS가 포기해도 Citadel의 `ExecRequest`는 계속 대기하고,
   늦게 오면 `bind`가 닫는다. 즉 리소스는 회수되지만 **대기는 취소되지 않는다.**
3. **`ssh-transport.ts`가 oxlint `max-lines` 상한(300)에 정확히 붙어 있다.** 다음 사람이 여기 3줄을
   더하면 lint가 터진다. `.oxlintrc.json` override로 넘기지 말고 분할을 고려하라 —
   이 파일은 이미 transport·채널·명령 실행 세 가지를 들고 있다.

## T. iOS 재QA — D1·D2 둘 다 PASS, 그리고 그 뒤에 있던 결함이 드러났다 (2026-08-23, 별도 에이전트, 고정 워크트리 `qa-ios-m2` @ `25e54ae8`)

| M2 | 첫 QA (`5b4f33ad`) | 재QA (`25e54ae8`) |
|---|---|---|
| (a) blocked 60초 내 발견 | FAIL | **PASS** — 25~30초, 10/10 기동 재현 |
| (b) pane 읽기 | FAIL ((a)에 막힘) | **FAIL — 새 결함** ↓ |
| (c) 30분 무변화 | 판정 불가 | 판정 불가 — (b)가 전제를 무너뜨림 (7.5분 4샘플은 `tmux=240x52` 불변) |
| (d) 백그라운드 10왕복 | PASS | **PASS** |
| (e) 넓은 pane 도달 | 판정 불가 | **FAIL** — (b)의 하류 |

**D2 PASS** — 강제종료 후 재기동 **10회 전부** 라이브. `the ssh channel is no longer open`이 로그·화면
**0건**. 바이너리 안에 그 문자열이 **여전히 존재**함을 `nm`으로 확인했으므로 "문자열이 사라져서 안 뜬 것"은
배제됐다. 수리 심볼(`signalReady`/`awaitReady`) 16개 실측.

**D1 PASS** — 세로에서 `settings` 탭이 실제 전이(`/ settings` + `BackButton` 출현). 버튼 y = **69.67**
(수리 전 31.7) ≥ 상태바 실측 54 / inset ≈59. 그리고 **이 수리가 처음 load-bearing하게 만드는
`useSafeAreaInsets()` 경로가 throw하지 않음이 첫 프레임 렌더로 확증**됐다 — 5개 화면 전부 appbar y=62.

**mock/live = LIVE, 위조 불가**: 화면에 `ZQ8M2-BLOCKED-AGENT`·`ZQ8M2-LAB-REMOTE`·`ZQ8M2-LAB-BRAVO`,
정본 목업 판별자(`reviewing PR #91` 등)는 0건, `1 nodes` / `1 blocked · 0 working`(픽스처는 4 / 8·16).

### U. 새 결함 — 프레임은 도착하고 터미널은 한 픽셀도 안 그린다 (iOS 한정, 미수리)

```
헤더        observing / Connected                     ← RN 쪽은 건강
WebView     frame={{0,88},{402,624}} exists=true      ← 정상 마운트
            innerStaticTexts=0
표면        (0,270)-(1206,2050) 단일색 (26,27,38) 2,115,877px
            핀치·스와이프 전후 프레임 바이트 동일
와이어      in 48B 구독(w2:p1) → out 12,834B → 150,633B
            strings: ZQ8M2-BRAVO-PANE-PROOF-7731, ZQ8M2-LIVE-TICK-1..10
```

XCUITest와 `simctl io screenshot` **두 독립 경로**가 같은 결론. **Android는 같은 코드로 정상 렌더한다** —
플랫폼 갈림이다. 첫 QA는 D2에 막혀 여기까지 도달한 적이 **없다** — 즉 이건 회귀가 아니라 *이제야 보이는* 결함이다.

#### 디스패처가 좁힌 것 (기기 없이, 2026-08-23)

1. **메시지 리스너 가설 기각.** react-native-webview가 iOS는 `window`·Android는 `document`로 배달하는 것은
   맞지만 `terminal-webview-html.ts:1875,1877`이 **둘 다 등록**한다.
2. **WebView JS는 실행됐다.** `armWebReadyWatchdog` 만료 → `reportEngineError` → `TerminalWebViewEngineErrorOverlay`
   (`TerminalWebView.tsx:394-396`)인데 **QA 화면에 오버레이가 없었다** → `web-ready` 핸드셰이크 성립.
3. **`flog`가 Metro에 안 뜬다** — `window.ReactNativeWebView.postMessage`로 RN에 가지만(`:336-344`)
   `handleMessage`가 `type:'log'`를 콘솔로 흘리지 않는다. Metro 로그 실검색 결과 터미널 진단 **0건**.
   **눈이 없다는 것 자체가 이 결함이 오래 숨을 수 있었던 이유다.**
4. 소스는 `{ html: XTERM_HTML }` 인라인, baseUrl 없음. 엔진 624,787B + HTML 72,539B ≈ 700KB.

#### 1순위 가설 [가설] — WebGL이 "붙었는데 안 그린다"

`terminal-webview-html.ts:777`이 `attachWebglAddon(true)`를 무조건 부르고,
`terminal-webview-webgl-recovery-injected.ts:18-56`은 **throw**와 **context loss**만 처리한다 —
**"붙었는데 빈 화면"에 대한 폴백이 없다.** 단일색 (26,27,38)은 테마 배경이므로 캔버스가 clear는 됐는데
글리프가 안 그려진 모양과 일치한다.

**이 가설이 맞으면 §P도 함께 답해진다** — WebGL이 살아 있으면 `.xterm-rows`가 null이고, 그러면
`ccbaafe4`의 프로브는 설계상 무동작이며 §P의 진단이 틀렸다는 뜻이 된다.

## V. §U는 재현되지 않는다 — 그리고 §P의 미지수가 닫혔다 (2026-08-23, iPhone 17 Pro 시뮬 `153F2FDE`, 코드 `25e54ae8`)

### V-1. §P의 load-bearing 미지수: `.xterm-rows`는 **null**이다 — WebGL이 그린다

세 경로가 같은 답을 냈다: 시뮬 Safari 하네스(`XTERM_HTML` 그대로 서빙), 앱 안의 생 `WebView`
(`source={XTERM_WEBVIEW_SOURCE}`), 그리고 제품 컴포넌트(`TerminalPaneView`). 모두 `.xterm-rows === null`,
`glProbe = OK WebGL 2.0`, 캔버스 2장.

⇒ §P의 표에서 **아래 칸**이 성립한다. `ccbaafe4`의 도색 프로브는 **설계상 무동작**이다:
`terminal-webview-painted-cell-injected.ts`의 `getPaintedCellWidth()`가 `.xterm-rows` 부재로 0을 반환하고
`getContentWidth()`는 `cellW * cols`, 즉 `ccbaafe4` **이전과 완전히 같은 식**으로 돌아간다.
따라서 §P가 고쳤다고 기록한 9열 격차는 **아직 안 고쳐졌고, 수리가 겨눈 층이 틀렸다.**
(WebGL이 붙는 한 Android도 같다 — §P의 "Android엔 SF Mono가 없어 DOM 렌더러" 전제는 렌더러 선택이
폰트가 아니라 WebGL 성공 여부로 갈린다는 사실을 놓쳤다.)

### V-2. "한 픽셀도 안 그린다"는 재현되지 않는다

같은 커밋·같은 시뮬·라이브 랩(격리 sshd 2222 + 일회용 ed25519 + 격리 XDG herdr 0.8.2, proto 21)에서
**전부 정상 렌더**했다:

| 조건 | 결과 |
|---|---|
| 94x39 일반 셸 pane (`SINK init len=4003`) | 렌더 |
| alt-screen TUI pane (`ESC[?1049h`) | 렌더 |
| **240x52 강제** (`SINK init len=12910`) — §U의 `12,834B`와 같은 급 | 렌더 (scale 0.209, 아주 작음) |
| 백그라운드→포그라운드 왕복 | 렌더 (배경색 비율 92.96% → 92.98%, 무변화) |
| 3-pane 워크스페이스(칩바 활성) | 렌더 |

WebGL 가설도 기각이다 — "붙었는데 안 그린다"는 어느 조건에서도 관측되지 않았다.

### V-3. §U의 판정 지표가 blank와 tiny를 구분하지 못한다

§U는 `(0,270)-(1206,2050)`에서 `단일색 (26,27,38) 2,115,877px`을 근거로 삼았다. 그 사각형은 2,146,680px이므로
**30,803px은 그 색이 아니었다** — "한 픽셀도" 와 모순된다. 그리고 **정상 렌더 중인** 240x52 화면을 같은
방법으로 재면 지배색이 **95.61%** 나온다(비지배 62,266px). 즉 이 지표는 "안 그림"과 "0.21배로 그림"을
가르지 못한다. `(26,27,38)`은 xterm 테마 배경일 뿐 아니라 `mobile-theme.ts:52`의 `terminalBg`이기도 해서
RN 컨테이너 배경과도 구별되지 않는다. `innerStaticTexts=0` 역시 WebGL 확정 이후로는 **정상값**이다.

또 §U의 좁힘 #3(`handleMessage`가 `type:'log'`를 콘솔로 안 흘린다)도 **틀렸다**:
`terminal-webview-notification-dispatch.ts:22-26`이 `console.log(tag, payload)`를 한다. Metro에 `[fit]`이
0건이었던 것은 눈이 없어서가 아니라 **그때 `flog`가 걸린 조건(commit-timeout/SUSPECT/measure-fail)이 전부
발동하지 않았기 때문** — 즉 건강한 터미널의 정상 출력이다.

### V-4. 그래서 고친 것 — 렌더러 정체를 매 init마다 보고한다

`reportRendererIdentity()` (`terminal-webview-painted-cell-injected.ts`), `commitFitScale`의
`reason === 'init-replay'`에서 1회. 실기기 실측:

```
[fit]renderer {"renderer":"webgl","domRows":false,"cellW":8,"paintedCellW":0,
               "contentW":1920,"vpWidth":402,"scale":0.209375,"cols":240,"rows":52}
```

이 한 줄이 §P의 두 갈래와 §U의 blank/tiny를 **기기 없이** 가른다. 고정 = 
`terminal-webview-init-surface.test.ts`의 webgl/dom 두 케이스(되돌리면 둘 다 RED).

### V-4b. 두 플랫폼이 같은 시험을 받지 않았다 (디스패처 대조, 2026-08-23)

§V가 못 본 것이 하나 더 있다. **Android (b) PASS와 iOS (b) FAIL은 다른 픽스처였다:**

| | pane 폭 | 판정 |
|---|---|---|
| Android M2 (b) | **80컬럼** (`00-driver.md:40` "80컬럼 pane 육안 판독") | PASS |
| iOS M2 (b) | **240컬럼** (`tmux=240x52`, 같은 QA의 (c) 샘플이 그렇게 적었다) | FAIL |

폰 뷰포트 402 CSS px에 240열을 넣으면 글자당 **약 1.7 CSS px**이다. 80열이면 약 5 CSS px.
**같은 코드가 한쪽에서 통과하고 한쪽에서 떨어진 것을 "플랫폼 갈림"으로 읽었는데, 폭이 3배 달랐다.**

그러므로 iOS (b) FAIL은 **취소되지 않는다** — 240열 pane은 실제로 읽을 수 없고 (b)는 *읽기* 수용
기준이다. 그러나 **원인이 "iOS가 안 그린다"가 아니라 "폰에서 240열은 읽을 수 없다"로 바뀐다**, 그리고
그건 B4(폰보다 넓은 pane)의 문제이며 v1이 지정한 해법은 (e)의 핀치줌이다.

→ **수리 대상이 아니라 픽스처 규율의 문제다.** `.prd/10`에 폭 고정을 넣었다: (b)는 80열, (e)는 넓은 pane.
그래야 두 플랫폼 판정이 비교 가능해진다.

### V-5. 잔여

1. **§U는 닫히지 않았다 — 기각도 아니고 재현도 아니다.** 재QA는 위 `[fit]renderer` 줄과 `SINK init` 여부를
   먼저 찍고, 픽셀 판정은 지배색 비율이 아니라 **비배경 픽셀 수**로 해라. 정상 240x52의 기준선은 약 4.4%다.
2. **§P의 9열 격차는 미수리다.** `ccbaafe4`는 WebGL 경로에서 무동작이므로, 원인은 DOM 도색 편차가 아니라
   다른 곳에 있다. 다음 조사는 WebGL 렌더러가 `css.cell.width`로 잡는 캔버스와 `clampPan`이 쓰는
   `getContentWidth()`가 실제로 어긋나는지부터.
3. **240열 pane은 폰에서 scale 0.21 = 겉보기 2.7 CSS px다.** 렌더는 되지만 읽을 수 없다. M2 (e)의 진짜
   문제는 "안 그린다"가 아니라 이것이고, 그건 다른 수리다.


## W. M4 Android QA — FAIL, 그리고 내가 "잔여"로 넘긴 것이 수용 기준이었다 (2026-08-23, 별도 에이전트, `qa-android-m4` @ `25e54ae8`)

```
M4 VERDICT: FAIL
  기내모드 ×10:        PASS — 10/10 자동복구 (2~138초, 앱 PID 22453 불변, 강제종료·리로드 0회)
  Wi-Fi↔셀룰러 ×10:    판정 불가 — 에뮬레이터 한계 (FAIL 아님)
  30분 백그라운드:      PASS — 30분 31초, 복귀 13초, 백그라운드 중 다이얼 0회
  강제종료로만 낫는 상태: 1건 (재현 2/2)  ← FAIL 사유
§Q 재부착: PASS (2·3·4초, transform·그리드 3/3 불변)
```

### 디스패처의 브리프가 틀렸다

나는 §L1의 잔여("마운트 시 실패한 원격은 앱 수명 내내 죽어 있다")를 **"재확인만 하면 된다"** 고 넘겼다.
판정자가 그것이 `.prd/04:175-177`의 **"강제종료로만 낫는 상태 0건"을 직접 위반**한다고 판정했다. 맞다.
**잔여로 분류하는 것과 수용 기준을 위반하는 것은 다른 일이고, 내가 그 둘을 뭉갰다.**

| | 재현 1 | 재현 2 |
|---|---|---|
| 원격 도달 가능해진 뒤 관측 | ~380초 | 221초 |
| 앱의 TCP 다이얼 시도 | **0회** | **0회** |

sshd 로그 대조로 "서버가 막은 것"이 배제됐다 — dead window의 `Connection from`은 QA의 프로브 1개뿐.
탈출구 4종(포그라운드 복귀 / 탭 전환 / pull-to-refresh / settings 왕복) 전부 0 다이얼,
`am force-stop` + 재실행만 10초에 복구.

**근인** (`app-connections.ts:246-291`): 다이얼이 `useEffect(..., [revision])` 마운트 1회고, `revision`은
키스토어 쓰기 카운터다. 실패한 원격은 `connections`에 안 들어가므로 `useSupervisedRemotes(connections)`가
감싸지 않고 → **L1 워치독도 L3 사다리도 리바이벌도 없다.** `createRedialableConnection(…, await open(), open)`
(`:151`)의 `await open()`이 던지면 그 원격은 아무것도 만들어지지 않는다 —
**재다이얼 기제(`845f0f22`)가 첫 다이얼 성공을 전제로 한다**는 것이 갈림점이다.

### PASS 쪽에서 확증된 것

- **§Q 수리(`d60afe9f`)의 미묘한 지점이 기기에서 확증됐다**: bridge PID를 죽여도 재부착이 2~4초,
  `transform: translate(0px, -597.906px) scale(2)`가 3/3 불변. `reset()`이었다면 `init` → `resetZoom()`으로
  `scale(0.310776)`이 됐어야 한다. **`resync()`가 `opened`/`cols`/`rows`를 유지한다**는 설계가 실측으로 닫혔다.
- 30분 백그라운드 중 **다이얼 0회** — `PaneReattachLadder.due()`의 `isForeground` 게이트 실증.
  **이후의 어떤 수리도 이걸 깨면 안 된다.**
- 기내모드 최장 복구 138초 = `TRICKLE_RECONNECT_DELAY_MS 90_000` 럼. 사다리 설계 안.

### 부수 발견 2건 (M4 기준 밖)

1. **에러 배너가 sticky — 화면이 거짓말을 한다.** 재부착 성공 후에도 헤더가 마지막 에러를 계속 표시한다:
   기내모드 사이클 후 `transport is closed`가 ~20분, 백그라운드 복귀 후 `IllegalStateException: Not connected`가
   **실시간 프레임이 흐르는 중에도** 지속(`s18c.png`에 `BANNER-CHECK-LIVE`가 렌더되는 동시에).
   **유저를 강제종료로 모는 바로 그 표면이다** — 위 FAIL 사유와 같은 방향을 가리킨다.
2. **outage마다 서버측 누수**: 사이클 종료 시 `sshd-session` 22개 + `remote-client-bridge` 7개 잔존
   (5개는 client가 사라진 지 15분 넘음, 2개는 launchd re-parent 고아). 폰 1대가 pane 1개 보는 비용.
