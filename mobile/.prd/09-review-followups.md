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

### ⛔ V-3은 틀렸다 — 2026-08-23 80컬럼 재QA가 반증했다 (§X 참조)

> **아래 V-3의 결론("§U가 tiny를 blank로 오독했다")은 폐기됐다.** §U가 근거로 쓴 30,803 비지배 픽셀의
> 정체가 **설정 기어 FAB**(RN 요소)임이 실측됐다 — 재QA가 같은 모양을 31,723px, 기어 박스
> `(960,264)-(1206,460)` 안으로 국소화했다. **§U의 "한 픽셀도 안 그린다"가 터미널에 대해 정확했다.**
> V-3이 남긴 유효한 부분은 방법론뿐이다: **지배색 비율이 아니라 비배경 픽셀 수로 재라.**
> 그 방법으로 재니 53컬럼에서 **비배경 0px, 색 1종**이 나왔다.

### V-3. (폐기됨) §U의 판정 지표가 blank와 tiny를 구분하지 못한다

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


## X. iOS M2 (b) 재QA — 80컬럼에서도 FAIL, 그리고 `init()`이 완주하지 않는다 (2026-08-23, 별도 에이전트, `qa-ios-m2` @ `3032ae3a`)

```
M2 (b) VERDICT: FAIL        폭=80컬럼 → pane 53컬럼
M2 (c) VERDICT: 판정 불가    14분 1초 관측 (30분 미달), 부분결과는 기하 불변 15/15
M2 (e) VERDICT: 판정 불가    ≥200컬럼 랩 미기동
```

### "너무 작아서 안 보인다"가 배제됐다

| | 폭 | 글자당 |
|---|---|---|
| 1차 iOS QA (§T) | 240컬럼 | 약 1.7 CSS px |
| Android PASS | 80컬럼 | 약 5 CSS px (추정) |
| **이번 재QA** | **80컬럼 → pane 53컬럼** | **약 7.6 CSS px** |

Android가 통과한 것과 **같은 `tmux -x 80 -y 40`** 을 썼고, herdr TUI 사이드바가 27열을 먹어 pane은 53열이다.
즉 Android보다도 글자가 크다. 그런데 **터미널 밴드 2,033,316px 중 비배경 0px, 색 1종** — 4회 런치·5장
스크린샷 동일, 그중 2회는 디버거 미부착.

### 결정적 음성: `[fit]renderer`가 발화하지 않는다

`3032ae3a`가 넣은 계측이 **0건**이다. 그리고 그 침묵이 파이프 유실이 아님이 증명됐다 — QA가 RN CDP
inspector(`Runtime.consoleAPICalled`)에 붙어 15초 간격 liveness 마커를 주입했고 **7건이 도착**했다.

`reportRendererIdentity()`는 `commitFitScale(reason === 'init-replay')`에서만 돌고, 그건
`applyFitScale('init-replay')` (`terminal-webview-html.ts:806`) — **WebView `init()` rAF 체인의 마지막 문장**이다.
⇒ **`init()`이 거기까지 못 갔다.**

그리고 **ready 워치독은 안 울렸다** (`terminal-webview-ready-watchdog.ts:11,38-41`이 15초 뒤 치명 에러를
올려 오버레이를 그린다 — 어느 스크린샷에도 없다). 즉 **`web-ready`는 도달했고 `init()`이 완주하지 않았다.**

> **이 상태를 보고하는 것이 아무것도 없다.** 워치독은 `web-ready` 이전만 보고, 새 계측은 init 성공
> *이후*만 본다. 그 사이가 통째로 사각지대이고, 이 결함이 두 라운드를 산 이유다.

### 와이어는 도착했다

tee 프로브 실측, 2회 재현:
```
client→server   53B  HRDRherdr-mx 핸드셰이크 + w1:p1 구독
server→client 3507B  ESC[2J@69 · ZQ9M2-PANE-PROOF-4417@89 · "COLS=53 ROWS=39"@193 · ZQ9M2-LINE-01..08
```

### 디스패처가 죽인 가설

**`TerminalPaneView`의 `opacity: 0`** (`:68`, `:102-104`) — **기각.** pane 라우트가 `active`를 **리터럴
`true`로** 넘긴다 (`app/h/[remoteId]/pane/[paneId].tsx:243`). 이 화면에서 hidden 스타일은 붙지 않는다.

### 1순위 용의자 (미확증)

`terminal-frame-sink.ts:148-160`이 `opened = true`를 **`target.init(...)` 호출 전에** 세운다. 그리고
`target.init`의 실체는 `use-pane-observer.ts:112`의 **`handleRef.current?.init(...)` — 옵셔널 체이닝**이다.
ref가 그 순간 null이면 init이 조용히 버려지고 `opened`는 영원히 true로 남아 이후 프레임이 전부 diff 경로로 간다.
같은 파일 `:109-111` 주석이 *"TerminalWebView queues anything posted before web-ready"* 라고 적었는데,
**그 큐잉은 handle 안에 있다 — handle 자체가 null이면 큐잉할 곳이 없다.** 주석이 커버한다고 믿는 창과
실제로 열린 창이 다르다.

### 하네스 사실 (다음 에이전트용, 각각 런 1회씩 태웠다)

- `-scheme herdr`로는 UI 테스트가 안 돈다 → **`-scheme herdrUITests`**
- `QA_SCRIPT_PATH`/`QA_OUT_DIR` env가 테스트 프로세스에 **안 닿는다** → QaDriver의 하드코딩
  `/tmp/qam2lab/{script.json,shots}`가 유일 채널
- 런치 직후 a11y 트리가 **비었다가 채워진다.** 좌표 탭 불안정(행 Pressable 프레임 y=133.7–182pt인데
  라벨은 ~114pt에 그려진다) → `tapText`로 요소를 탭하라
- **Metro는 앱 `console.log`를 로그파일에 안 흘린다.** CDP inspector(`http://127.0.0.1:8081/json/list`)를 쓰라

## Y. §U/§X 근인 — 콜드 런치에서 `init`이 버려진다 (2026-08-23, 커밋 `7c58c49d`, 기기 A/B 확증)

두 QA 라운드가 같은 것을 쟀다: 헤더 건강(`observing`/`Connected`), 랩 고유 문자열을 담은 풀프레임이
폰의 ssh 채널에 도착, 그런데 터미널 밴드는 단색. `[fit]renderer`도 ready 워치독도 안 울렸다 —
**아무도 안 보는 구간에서 멈춘 것**이다.

### 사슬과 멈추는 지점

```
pane-observer.ts:428-441  onMessage → sink.accept
terminal-frame-sink.ts:148-160  첫 full 프레임 → opened=true → target.init  (한 번만, 영원히)
use-pane-observer.ts:112        → handleRef.current?.init
TerminalWebView.tsx:252-288     → postMessage → pendingMessages.queue  (document 미준비 시 큐)
                    :199-207    handleLoadStart → pendingMessages.clear()   ← 여기서 버려진다
                    :105-140    web-ready → flushPendingMessages            ← 이미 빈 큐
```

시뮬레이터 실측 (콜드 런치, tmux 80x40, pane `w1:p1`):
```
t+396ms  pm.queue init 2                                          (webReady=false)
t+466ms  wv.loadStart
         pm.clear-dropping ["set-theme","set-font-scale","init"]   ← init 폐기
t+501ms  wv.web-ready
         pm.flush []
```
그 뒤 세션 내내 `[fit]` 0줄, 밴드 2,033,316px 단색 — **QA 측정과 바이트 단위로 동일.**

### 어긋나는 두 가지

| | |
|---|---|
| `terminal-frame-sink.ts:153-159` | `opened = true`를 `target.init(...)` **전에** 세우고 **두 번째 init을 영영 안 낸다** — init은 화면 수명당 1회 |
| `TerminalWebView.tsx:205` | `onLoadStart`에서 큐를 통째로 버린다 — **리로드 staleness**를 위해 쓰인 정책을, **어떤 document에도 도달한 적 없는** 메시지에 적용 |

### 왜 두 라운드가 걸렸나 — 판별자는 콜드/웜이었다

폭도, 에이전트 종류도, WebGL도 아니다. **실행 중인 앱에서의 웜 리마운트**(`router.replace` → `push`)는
document가 이미 로딩을 시작한 뒤라 `onLoadStart`가 그 창에 안 들어오고, **같은 코드가 매번 렌더된다.**
콜드 런치는 `onLoadStart`를 첫 풀프레임보다 **~70ms 뒤**에 놓는다 — 지는 순서이고, QA 스크립트
(`20초 부팅 대기 → tapText → pane`)가 정확히 그걸 만든다. §V의 조사 랩이 웜이었던 것이 그 라운드가
아무것도 재현 못 한 이유다.

### 디스패처의 1순위 용의자는 틀렸다

나는 `use-pane-observer.ts:112`의 `handleRef.current?.init(...)` 옵셔널 체이닝을 지목했다.
수리 에이전트가 **가정하지 않고 계측했고**, 모든 `target.init`이 `handleNull:false`였다.
ref는 붙어 있었고 손실은 한 홉 뒤였다.

### 기기 A/B (같은 랩·픽스처, 둘 다 콜드 런치)

| | `[fit]` 줄 | 밴드 색 수 | 비배경 px |
|---|---|---|---|
| 수리 없이 | 0 | 1 | 0 |
| 수리 후 | 1 | **909** | **35,153** |

### 잔여 (고치지 않음)

1. **one-shot 계약 자체가 여전히 취약하다.** `terminal-frame-sink.ts:153`이 전달 **전에** `opened`를 세우고,
   사슬 어디에도 재-init을 요청할 수단이 없다. durable fix는 **전달 ack** 또는 `requestReinit` 이음매다.
2. **기하 열화** — 수리 에이전트의 프레임이 `w:80`으로 왔는데 pane은 53열이다(`DEFAULT_OBSERVER_COLS`,
   `observer-geometry.ts:66`). `pane.layout`이 제때 resolve 안 됐다는 뜻. 과다요청은 패딩만 하므로 무해하지만
   **기하 경로가 조용히 폴백했다**는 신호다. QA 랩은 진짜 53을 받았다.
3. **content-process 손실 후 중간 구간 stale** — 교체 document는 *마지막* 스냅샷 + 이후 diff를 받으므로,
   죽은 document로 간 프레임은 herdr이 다음 풀프레임을 낼 때까지 빠진다. blank → 약간-stale의 교환.
4. **alt-screen 픽스처 미시험** — 수리 에이전트의 픽스처는 정적 53열 셸이었다. 결함이 그것 없이 픽셀 단위로
   재현됐으므로 load-bearing은 아니지만, `normalizeInitialData`의 alt-screen replay 경로는 미검증이다.

## Z. M4 재QA — PASS. 지난 FAIL 사유가 닫혔다 (2026-08-23, 별도 에이전트, `qa-m4b` @ `147af3be`)

```
M4 VERDICT: PASS
  강제종료로만 낫는 상태: 0건        ← §W의 유일한 FAIL 사유, 수리 확인
R1 실패-원격 재다이얼: PASS
R2 에러 소거:         PASS
R3 늦은 실패 격리:     판정 불가 (negative만)
```

### R1 — 사다리가 상수까지 맞는다

44초간 다이얼 **7회**, 간격 **0.5 / 1 / 2 / 4 / 8 / 15초** = `RECONNECT_DELAYS`와 **정확히 일치**.
즉 새 사다리가 L3 상수를 재기술하지 않고 상속했다는 설계 주장이 실측으로 확인됐다.
포그라운드 복귀 후 **0.6초** 만에 다이얼하고 그 뒤 0.5/1/2초로 재시작 — **카운터 리셋까지 확증**.
앱 PID **28166**이 09:57~10:24 전 구간 불변 — 실패 원격이 살아난 뒤 앱이 **스스로** 붙었다.

**백그라운드 다이얼 0회**(회귀 축)도 새 빌드에서 확인됐다. 그리고 그 0이 의미를 갖도록
**채널 생존을 별도 증명**했다 — 같은 창에 프로브 5회(`probe_ok`), DIAL 12건은 전부 프로브 마커 사이에
끼어 전수 귀속됨.

### R2 — 20분이 30초가 됐다

`transport is closed`가 복구 후 **약 30초 내 소멸**(종전 약 20분). 그리고 반대 방향도 확인 —
아웃티지 91초 경과 시점(재시도 중)에는 **여전히 표시**된다. 두 방향 다 맞아야 수리다.

### ⚠️ 판정 범위 — 디스패처가 명시한다

이 PASS는 **§W의 FAIL 사유에 대한 것**이다. M4 수용 기준의 나머지는 이번 빌드에서 전량 재실행되지 **않았다**:

| 기준 | 이번 빌드 | 이전 빌드(`25e54ae8`, §W) |
|---|---|---|
| 기내모드 ×10 | **5회** | 10/10 PASS |
| Wi-Fi↔셀룰러 ×10 | 미시도 | 판정 불가 (에뮬 한계) |
| 30분 백그라운드 | 9분 + 5분22초 두 창 (툴 10분 상한) | 30분 31초 PASS |

**교차-빌드 조합이라는 것을 숨기지 않는다.** 다만 이번 수리가 깨뜨릴 수 있었던 **유일한 축은
백그라운드 다이얼 0회**였고(사다리를 `ConnectionSupervisor`에 붙였다면 그게 깨졌다), 그 축은
**새 빌드에서 실측됐다.** 나머지는 이번 변경과 인과가 없다.

### 판별자 함정 1건 (기록 가치)

터미널 프롬프트의 `fable-m5max`는 **목업 판별자 호스트명과 같은 문자열인데 이 맥의 실제 hostname이다**
(목업이 그걸 베낀 것). 판정자가 이걸 알아채고 호스트명을 판별자에서 빼고 **난수 토큰만** 근거로 삼았다.
→ `.prd/10`의 mock/live 절이 호스트 4종을 판별자로 적고 있는데, **랩이 이 맥에서 돌면 그중 하나가 위양성이다.**

## AA. iOS M2 닫힘 — 5/5 (2026-08-23, 별도 에이전트, `qa-ios-m2b` @ `105a2ea5`)

```
M2 (b) VERDICT: PASS   폭=80컬럼 → pane 53×39, 비배경 10,142px(FAB 31,723 제외), scale=0.628
M2 (e) VERDICT: PASS   폭=213컬럼, 우측 끝 도달 YES, §P 격차 = 재현 안 됨(0열 손실)
M2 (c) VERDICT: PASS   30분 30초, 폰 7샷 픽셀 동일 · 데스크톱 md5 315샘플 바이트 동일
```
(a)·(d)는 §T에서 PASS. **iOS M2 = 5/5.**

### 수리가 먹었다 — 같은 계측이 양방향으로 답했다

`[fit]renderer`가 pane마다 정확히 1건, 총 4건. **지난 두 회차의 0건이 근인을 가리켰고, 이번의 4건이 수리를 확증한다.**
채널 생존은 같은 CDP 채널로 흘러온 keychain 에러로 별도 증명됐다 — 침묵도 발화도 둘 다 근거를 갖췄다.

```
11:33:24  cols 80  scale 0.628125   contentW 640    ← (b)
11:37:13  cols 214 scale 0.234813   contentW 1712   ← (e)
```

### §P는 iOS에서 재현되지 않았다 — 예상과 반대다

Android는 213컬럼 중 마지막 7~9열 도달 불가였다. iOS는 **기본 fit 배율에서 213열 전체가 뷰포트에 들어온다**:
룰러 마지막 문자 `2`(=213번째 열)와 우측 끝 토큰 `ZEQA-4814cf0e5355` **17자 전부** 렌더, 잘림 0자.
**예상을 판정으로 쓰지 않고 실측했고, 예상이 틀렸다.**

### 핀치줌 제스처는 판정 불가 (수용 기준과 별개)

`app.pinch` · `webViews.pinch` · `doubleTap` 3종 모두 **픽셀 완전 동일**(6,157 / 607 / 32,063 불변), 콘솔에 터치 로그 0건.
구분 안 되는 두 가설: (A) iOS/WebGL에서 앱 핀치줌이 무동작 (B) XCUITest 합성 핀치가 WKWebView의 JS `touch*`에 미도달.
`terminal-webview-pinch-zoom.test.ts`가 유닛 9/9인 것은 **기기 측정이 아니므로 판정 근거로 쓰이지 않았다.**
(e)의 수용 기준은 "우측 끝 도달"이고 그건 fit 배율에서 이미 성립하므로 **PASS는 유효하다.**

### ⚠️ 내가 넣은 계측에 결함이 있다 (`3032ae3a`)

**`[fit]renderer`의 `cols`는 서버 그리드가 아니다.**

| 시험 | 계측 `cols` | pty 실측 |
|---|---|---|
| (b) | **80** | **53** |
| (e) | **214** | **213** |

프로브가 서버 지오메트리 도착 **전** xterm 기본값을 읽는 것으로 보인다.
**다음 회차가 이 필드를 그리드 근거로 쓰면 또 한 라운드를 태운다.** 수리 대상.
(`paintedCellW:0`·`domRows:false`는 WebGL 경로에서 항상 그 값이고 §P 판정과 일관된다.)

## BB. iOS M3 — PASS 11/11, 그리고 서명 게이트가 UI를 막고 있다 (2026-08-23, 별도 에이전트, `qa-ios-m2b` @ `105a2ea5`)

```
M3 VERDICT: PASS
  액세서리 키 바이트:  11/11  (1b 09 0d 20 1b5b43 03 04 0c 1a 1b5b44 1b5b41 — Android 정본과 바이트 동일)
  Ctrl-C 실효:        PASS  (sleep 300 = PID 24734가 실제로 죽음, ps 확인)
  PTY 불변:           PASS  (53×39 3회 실측, resize 0건 — 와이어 1468파일 전수 grep)
  본문 입력 반영:      PASS  (재진입 없이, 퀵커맨드·텍스트필드 두 경로)
```

판정을 **화면이 아니라 PTY 수신 바이트**로 했다 — 랩 pane 안에서 raw-mode 스니퍼를 돌려 도착 바이트를
`%02x`로 기록. 화면으로는 `←`와 `^[[D`가 구별되지 않는다.

**앱은 바이트를 안 보낸다 — 키 이름을 보내고 바이트는 서버가 만든다** (`pane.send_input{keys:["esc"]}` 와이어 실물).
설계대로다(`terminal-accessory-herdr-keys.ts`).

### 브리프에 건 덤이 값을 냈다 — 핀치 가설이 좁혀졌다

§AA가 핀치 무반응을 두 가설로 남겼다: (A) 앱 무동작 / (B) XCUITest 합성 제스처가 WKWebView JS에 미도달.

M3에서 **합성 탭이 RN 네이티브 층(Pressable → onPress → ssh 호출)까지 19회 도달**했다.
⇒ **A는 RN 층에서 기각**되고, 실패가 **WKWebView 경계로 국소화**된다 → B 쪽으로 기운다.
단 이번 런은 WebView에 제스처를 한 번도 주입하지 않았으므로 **B 자체는 미증명**이다.
(키 경로와 터치 경로가 다르다는 이유로 걸어둔 관측이 실제로 갈랐다.)

### 결함 후보 2건 (M3 수용 기준 위반 아님 — 대체 경로가 산다)

1. **`Send input`(↵) 버튼이 소프트 키보드에 덮인다.** frame `{{352,796},{38,38}}`, 창 높이 874pt →
   키보드가 올라오면 `isHittable=false`, 탭 실패 실측. 인간 경로는 키보드 자체의 Return
   (`returnKeyType="send"` + `onSubmitEditing`)이고 그건 통과했다. **§R D1과 같은 계열의 하단 기하 문제.**
2. **expo-notifications 에러 배너가 입력 필드를 덮는다 — 다만 이건 개발 빌드 산출물이다.**

   > **⚠️ 디스패처 정정 (2026-08-23).** 나는 이걸 처음에 "제품 결함"으로 드라이버 게이트 표에 승격시켰다.
   > **틀렸다.** 출처를 추적하니 앱이 그리는 배너가 아니다 —
   > `node_modules/expo-notifications/build/DevicePushTokenAutoRegistration.fx.js:103`의 **`console.error`**이고,
   > RN 개발 모드가 그걸 **LogBox** 알림으로 화면 하단에 띄운 것이다. **릴리즈 빌드엔 LogBox가 없다.**
   > 앱 소스에 그 문자열을 렌더하는 컴포넌트가 **0개**임을 grep으로 확인했다.
   > → **유저가 부딪히는 결함이 아니다. QA 하네스가 부딪히는 장애물이다.**
   > 남는 진짜 문제는 그 아래의 키체인 실패 자체(= M2b 서명 게이트)이고, 릴리즈에서는 **조용히**
   > 토큰이 안 나오는 형태로 나타난다. 확정 시험은 **릴리즈 빌드에서 이 배너가 없는지** 보는 것이다.

   배너 `{{10,786.7},{382,67.3}}` ⊃ 필드 `{{13,798.7},{330,32.3}}` — **완전 포함.**
   배너를 닫기 전엔 `Neither element nor any descendant has keyboard focus`로 **타이핑 자체가 불가**했다.
   원인은 배너 문구가 말한다: `Keychain access failed: A required entitlement isn't present`
   → **M2b를 판정 불가로 만든 그 코드사이닝 아이덴티티 부재가 여기서 UI 차단으로 재등장한다.**
   즉 서명 게이트는 "M2b를 못 재는 것"에 그치지 않고 **앱을 실제로 망가뜨리고 있다.**

### 하네스 함정 (다음 사람 몫)

- **`QA_NO_LAUNCH`도 `QA_SCRIPT_PATH`처럼 테스트 프로세스에 안 닿는다** — 매 런이 앱을 재기동하므로
  스크립트마다 전체 네비게이션을 다시 넣어야 한다. 런 1회를 태웠다.
- **가로 ScrollView 키 행은 앞뒤로 다 쓸어야 한다** — 앞으로만 스크롤하면 지나친 키를 영영 못 잡는다
  (Arrow Up 1회 MISS의 원인, **앱 결함 아님**).

## CC. M6a·M6c 둘 다 FAIL — 그리고 M6c에 대한 내 판정이 틀렸다 (2026-08-23, 별도 에이전트, `qa-m6` @ `e3e4d846`)

```
M6a VERDICT: FAIL   스와이프가 한 번도 활성화되지 않는다
M6c VERDICT: FAIL   스크롤백이 0행에서 자라지 않는다
```

### ⛔ 디스패처 정정 — M6c는 "이미 구현돼 있었다"가 아니다

나는 한 시간 전 커밋(`e3e4d846`)에서 **"로컬 스크롤백은 완성돼 있고 남은 건 QA뿐"** 이라고 적었다.
**틀렸다.** 배관(`touchmove` → `term.scrollLines`)은 있지만 **스크롤할 것이 영영 생기지 않는다.**

QA 실측: 25행 뷰포트에 60행을 흘려 35행이 밀려났는데
```
.xterm-viewport   scrollHeight == clientHeight == 777      (스크롤백 0행)
스와이프 2회 후    최상단이 SLOW-39로 불변
```

**근인은 렌더러다.** `src/protocol/render_ansi.rs:613`이 셀마다 **절대 커서 위치**를 쓴다:
```rust
write!(writer, "\x1b[{};{}H", y + 1, x + 1)
```
**절대 위치는 터미널을 스크롤시키지 않는다** — 개행이 아니라 덮어쓰기다. 그래서 xterm의 뷰포트 내용은
제자리에서 교체되고 **아무것도 스크롤백 버퍼에 들어가지 않는다.** `scrollHeight == clientHeight`가
그 서명이다. `scrollback: 5000` 설정은 **무동작**이다 — 채울 경로가 없다.

이건 B13이 이미 적어둔 사실의 다른 면이다(*"BlitEncoder가 모든 셀 앞에 `ESC[row;colH`를 낸다"*).
나는 그 문장을 **비용**으로만 읽었고 **스크롤백 불가**라는 함의를 놓쳤다.

### M6c에는 앱 배선으로 가는 길이 없다 — 결정이 필요하다

| 선택지 | 비용 | 막는 것 |
|---|---|---|
| ① 서버가 스크롤 인지 출력(개행)을 낸다 | `BlitEncoder` 재작성 — B13이 이미 큰 작업으로 표시 | 없음(단 크다) |
| ② attach 모드의 `AttachScroll` | 공유 PTY 리사이즈·락 | **§2.3 — M6b를 삭제한 바로 그 이유** |
| ③ JSON API에 pane 히스토리 메서드 신설 | 서버 변경(작음). observe와 직교 | 없음 — **현재 API에 그런 메서드가 없다**(`src/api/schema/panes.rs` 확인) |
| ④ **M6c를 드롭한다** | 기능 없음 | 없음 |

**⚠️ 정정 (같은 날, 위 표를 쓴 직후):** ③은 **신설이 아니다. 이미 있다.**

```
pane.read { pane_id, source: "recent" | "recent_unwrapped", lines: Option<u32>,
            format, strip_ansi }          src/api/schema/panes.rs:275-287
  → ReadSource::Recent
  → terminal.recent_text_snapshot(recent_lines)   src/app/api_helpers.rs:123
```

즉 **폰이 히스토리를 요청하는 경로가 JSON API에 이미 있고, M3의 입력이 쓰는 바로 그 API다.**
observe 스트림과 직교하므로 §2.3의 거래를 건드리지 않는다. **서버 변경 0.**

→ **결정은 필요 없다. ③으로 간다.** 유저 결정으로 올렸던 것은 내가 API 표면을 다 안 보고 쓴 것이다
(`grep -rhoE '"pane\.[a-z_]+"' src/api/`로 36개 메서드가 나온다).

**다만 설계 제약이 하나 남는다**: 가져온 히스토리를 **xterm 버퍼에 이어붙일 수 없다** — 렌더러가
절대 위치로 덮어쓰므로 그 버퍼는 "현재 화면"이지 스트림이 아니다. 그러므로 히스토리는 **별도 표면**
(오버레이/화면)이어야 하고, 그게 아키텍처와 싸우지 않는 유일한 형태다.

### M6a — RNGH는 있는데 활성화되지 않는다

**네이티브 미포함은 배제됐다**:
- `libgesturehandler.so`가 **4개 ABI 전부** APK에 있다
- `RNGestureHandlerRootView`가 네이티브 뷰 트리에 **실제 마운트**(bounds `0,314-1080,1988`)
- 터치가 앱에 **도달한다** — WebView document 카운터가 제스처마다 증가(`{ts:1,tm:15,te:1}`)

**그런데 `touchcancel`이 5회 제스처 내내 0**이다. 구현 자신의 계약(`[paneId].tsx:236-240`)이
*"활성화되기 전까지 WebView가 모든 터치를 그대로 받고, 활성화되는 순간에만 cancel을 받는다"* 라고 적었으므로
**cancel 0 = 활성화 0**이다. 방향도 경계값이 아니었다(dx −600/−700, 칩 index 0 → p3 존재).

**대조군**: 칩 탭은 동작한다(p1→p3 확인). 라우팅과 `router.replace`는 멀쩡하고 **제스처만 끊긴 고리**다.

**남은 미반증 가설 1개**: 모든 제스처가 adb 합성이었다(`input swipe` / `motionevent` 개별 / 단일셸 버스트 3종).
**실제 손가락 1회가 유일한 반증 경로다.**
> 참고: iOS §AA에서도 **합성 핀치가 WKWebView JS에 도달하지 못했다**(가설 B). 두 플랫폼에서 같은 모양이
> 나온 것은 **합성 제스처 하네스 자체의 한계**를 시사한다 — 다만 여기서는 RNGH가 네이티브 층이라
> iOS 건과 층이 다르므로 같은 원인이라고 단정하지 않는다.

**유력한 코드 측 후보(미확증)**: Android WebView가 터치를 소비하면 부모가 가로채지 못한다.
RNGH가 그걸 해결하도록 설계돼 있지만, WebView가 `requestDisallowInterceptTouchEvent`를 잡고 있으면
루트 뷰도 못 뺏는다. 다음 조사는 여기서 시작하라.

### 부수 실측 — 전환 지연이 기준을 초과한다

칩 탭 경로(스와이프와 같은 `router.replace`) 프레임 분석: 마지막 옛 내용 3.238s → **공백** 3.285s →
새 내용 3.830s = **592ms**, 그리드 107×25. **M6a 기준 <200ms의 3배다.**
스와이프가 고쳐져도 이 항은 남는다 — 그리고 예상대로 **공백 구간**이 있다(서버가 베이스라인을 리셋하고
보내는 풀 프레임이 무압축 ANSI로 건너오는 B13 비용).
**재연결은 없다**(sshd 연결 2건, 전환 전후 불변) — 지연은 재다이얼이 아니라 프레임 크기다.

## DD. M6a·M6c 수리 — 근인 2건, 그리고 내 주석이 QA의 판정 기준을 틀리게 했다 (2026-08-23)

### M6a 근인 — `nestedScrollEnabled` 한 줄이 모든 제스처를 터치다운에서 죽였다 (`9a256d0a`)

계측(실기 Pan에 `onBegin`/`onTouchesDown`/`onFinalize` 부착):
```
onBegin → touchesDown → onFinalize success=false state=3(CANCELLED)
                        같은 밀리초, move 한 번 없이
```

`nestedScrollEnabled`는 Android 전용이고 구현이 한 줄이다 — `RNCWebView.onTouchEvent`
(`node_modules/react-native-webview/android/.../RNCWebView.java:125-131`)가 **모든** MotionEvent에서
`requestDisallowInterceptTouchEvent(true)`를 부르고, 그게 `RNGestureHandlerRootView.kt:52-57` →
`RootHelper.kt:104-112` → `tryCancelAllHandlers()`로 올라간다.

**어긋나는 두 가지**: RootHelper가 `passingTouch` 플래그로 이걸 막게 돼 있는데(`:114-123`),
**자식에게 디스패치하기 전에 플래그를 지운다.** 그래서 WebView의 호출은 항상 가드 밖에 떨어지고 항상 취소한다.
`GestureHandlerRootView`의 화면 스코프는 **원인이 아니었다.**

**A/B (같은 합성 입력, prop만 변경)**:

| `nestedScrollEnabled` | pan 상태 | 전환 |
|---|---|---|
| on | CANCELLED(3) at DOWN, `onStart` 없음 | 없음 |
| off | `onStart` → `onUpdate dx=-118…` → `onEnd dx=-232` → success | **w1:p3 → w1:p2** |

⇒ **QA가 남긴 "합성 입력 한계" 가설은 죽었다.** 합성 입력은 이 인식기를 활성화까지 몰고 간다.

**아이러니**: 그 prop은 orca에서 이식됐고 주석이 *"Android parent gesture containers can intercept
vertical drags"* 였다 — **우리가 나중에 원하게 된 바로 그것을 방어하고 있었다.** 이식 당시엔 옳았다.

### ⛔ 내 주석이 QA의 오라클을 틀리게 했다

M6a 구현 때 내가 승인한 주석(`[paneId].tsx:236-240`)이 *"활성화되는 순간에만 cancel을 받는다"* 라고 적었다.
**Android RNGH는 `touchcancel`을 주입하지 않는다 — 전달을 멈출 뿐이다.**
`touchcancel`은 **양쪽 상태에서 다 0**이라 아무것도 구별하지 못하고, 진짜 신호는 **사라진 `touchend`**다:

| 제스처 | pan 상태 | WebView document 수신 |
|---|---|---|
| 수직 | FAILED(1) | ts 1 / tm 24 / **te 1** — 전체 유지 |
| 수평 | ACTIVE → END(5) | ts 1 / tm 1 / **te 0** — 활성화에서 전달 중단 |

**QA의 FAIL 판정은 옳았고 근거만 틀렸다 — 그리고 그 근거를 내가 제공했다.**

### M6c — orca는 왜 되고 herdr은 왜 안 되나 (`264b4479`)

수리 에이전트가 orca를 직접 읽었다(`/tmp/orca-probe`):

| | 전송 | 히스토리 |
|---|---|---|
| **orca** | 스냅샷 프레임 + **raw PTY 바이트** (`rpc-client-terminal-binary-frame.ts:33-38,67`) | 바이트에 개행이 있어 로컬 버퍼가 스크롤 → **히스토리 = xterm 버퍼**. `scrollback` 참조 20건 전부 로컬, fetch 0건 |
| **herdr** | 셀마다 절대 커서 위치 (`render_ansi.rs:613`) | 덮어쓰기라 쌓일 것이 없다 |

**같은 기능인데 전송 형식이 달라 구현 형태가 갈린다.** 닫힌 전제를 따르려고 orca를 읽은 것이
"왜 못 따르는가"의 답을 줬다.

→ **`pane.read{source:"recent_unwrapped", lines:1000}` + 터미널을 *덮는* 별도 오버레이.**
`lines: 1000`은 서버 자신의 clamp(`api_helpers.rs:118`, 생략 시 기본 80 ≈ 두 화면).
B8(호출 1회 = exec 1회)이 나머지를 결정: pane별 캐시 · in-flight 공유 · **타이머 만료 없음**
(자기 갱신은 폴링이고 폴링이 B8이 금지하는 것) · pane 전환은 재읽기가 아니라 닫기.

**진입은 버튼이다** — 수직 드래그가 아니다. `failOffsetY(±12)`가 수직을 터미널에 준 것을 되돌리면
M6a가 방금 지킨 스크롤 라우팅이 죽는다.

### ⚠️ 기기 QA가 답해야 할 최대 위험 (유닛으로 못 봄)

**herdr 서버 쪽 스크롤백 버퍼에 실제로 내용이 있는가.** API가 존재하고 `text`를 반환한다는 것까지가
현재 증거다. **비어 있으면 M6c는 다른 이유로 또 FAIL이다.**

### 부수 발견 (고치지 않음)

- **`pane.read`의 `strip_ansi`가 죽은 파라미터다** — `src/api/schema/panes.rs:283`에 기본값 `true`로
  선언돼 있는데 `handle_pane_read`(`src/app/api/panes.rs:1189-1228`)가 **한 번도 읽지 않는다**(참조 0건, 직접 확인).
  `format`만 text/ANSI를 고른다. 서버 쪽 정리 대상.
- **pane 전환마다 터미널 WebView 문서가 통째로 재생성된다** — CDP 타깃 id로 측정. **칩 탭도 마찬가지라
  M6a 이전부터다.** 와이어 주장(재연결 없음)은 참이지만 **730KB xterm 문서 재빌드**가 미검증 `<200ms`
  예산이 실제로 쓰이는 곳이다(실측 592ms와 맞물린다). 별도 측정 대상.

---

## EE. exec 데드라인 vs redial 정책 — 오분류는 있으나 내 회귀가 아니다 (2026-08-23, 미독 잔여 해소)

`b411ef04`(exec-ack 데드라인)이 기존 redial 정책과 이중 계상되는지가 미독 잔여였다. 읽었다.

### 파일이 스스로 그은 선

`src/transport/observe-stream-link.ts` 헤더가 비싼 수리(ssh 재다이얼 = TCP+KEX+서명+원격 herdr
신규 프로세스, B8)를 두 기준으로 나눈다:

| 기준 | 증거 등급 | 행동 |
|---|---|---|
| **exec 채널 개설 거부** | 사실 — ssh 세션이 죽었다 | 다음 다이얼에서 즉시 재다이얼 |
| **연속 `SSH_REDIAL_AFTER_FAILED_DIALS`(=3) 다이얼이 `Welcome` 미도달** | 의심 — "half-open TCP는 채널을 *받아준다*, 뭔가 타임아웃 날 때까지" | 3회 후 재다이얼 + `redialledAtFailure` 레이트리밋 |

### 실제 코드

`observe-stream-link.ts:386`이 `connection.transport.openChannel(...)`의 **모든** rejection에
`execOpenRefused = true`를 놓는다. 그런데 그 rejection에는 **타임아웃도 들어온다**:

- **Android**: `HerdrSshSession.kt:101` `client.timeout = config.connectTimeoutMs` — sshj가
  `startSession()`/`session.exec()`를 그 예산으로 묶는다. **`b411ef04` 이전부터 그랬다.**
- **iOS**: `awaitExecAck`(`ssh-transport.ts:291`)가 같은 20s 예산으로 reject. `b411ef04`부터.

**타임아웃은 사실이 아니라 의심이고, 정확히 위 표의 두 번째 행이 쓰라고 쓰인 그 의심이다**
("뭔가 타임아웃 날 때까지" — 내 데드라인이 바로 그 "뭔가"다).

### 결과

`owed = execOpenRefused || failedDials - redialledAtFailure >= 3` — 왼쪽이 단락시켜
**레이트리밋을 통째로 우회**한다. 느리지만 살아 있는 원격에서는 L3 rung마다 full ssh 재다이얼 1회가
되고, 그 재다이얼은 같은 느린 링크 위에서 핸드셰이크를 다시 해야 한다.

### 판정: 기록만, 수리 안 함

1. **회귀가 아니다.** 오분류는 Android에 선재했고 `b411ef04`는 iOS를 Android 동작에 맞춘 것이다.
   데드라인 이전 iOS는 이 자리에서 **영구 행**이었다 — 오분류는 행보다 낫다.
2. **관측된 증상이 없다.**
3. **M4(생존성/재연결)가 이미 별도-에이전트 PASS다**(§Z). 재연결 분류를 지금 바꾸면 그 PASS가
   무효가 되고, 재QA 2건이 아직 미결인 상태에서 green 리시트 하나를 churn하게 된다.

수리한다면 최소 형태: 데드라인 rejection에 식별 가능한 에러 타입을 주고(`channel-failure.ts`가
이미 `ChannelCloseError`의 집이고 `modules/herdr-ssh`가 이미 거기서 import한다),
`:386`에서 그 타입만 `execOpenRefused`에서 제외 → 인내 기준으로 흘려보낸다. half-open TCP 복구는
여전히 일어나되 1 rung이 아니라 3 rung 후가 된다 — 그게 설계가 고른 값이다.

---

## FF. M6a PASS · M6c FAIL — 그리고 §D1이 한 화면 뒤에서 재발했다 (2026-08-23, 별도 에이전트, `qa-m6b` @ `264b4479`)

APK 16:15:35 / 커밋 `264b4479` 16:10:42 — 대상 코드 확인. live 판정, 근거는 pane별 난수 토큰
(`TOKEN-0bb0dabe` / `PANE2-TOKEN-e8db32b0` / `PANE3-TOKEN-f4c23551`)이 각자의 화면에 렌더된 것.
픽스처 pane 3개, 서버 보고 `viewport_rows` p1=27 / p2=13 / p3=12.

### M6a PASS — 1차 FAIL의 근인이 실제로 죽었다

`9a256d0a`(`nestedScrollEnabled` 제거)가 수리로 확증됐다. 좌 p1→p2→p3, 우 p3→p2→p1, 칩 순서 일치,
양 끝 no-op(순환 없음), 수직축은 터미널이 보존, **sshd `Accepted publickey` = 2로 8회 이상 전환 내내 불변**
(앱 다이얼 1 + 프로브 1) — §2.3의 "리타겟이지 재연결이 아니다"가 와이어에서 성립.

**지연 분해가 이 판정의 값어치다.** 60fps VFR 녹화 프레임 실측:

| 구간 | 시각 | 누적 | 귀속 |
|---|---|---|---|
| 제스처 종료 | t≈4.19 | — | — |
| 헤더 커밋 시작 | t=4.3744 | **184ms** | **스와이프분 — `<200ms` 충족** |
| 헤더 정착 | t=4.7754 | 585ms | 크로스페이드 |
| 새 pane 본문 완전 페인트 | t=4.9061 | 716ms | + WebView 문서 재빌드 |

즉 예산은 지켰고, 나머지 ~530ms는 M6a 소유가 아니다.

### ⚠️ 별건이 M6a보다 크다 — 문서 재빌드가 초 단위로 튄다

278줄 버퍼를 가진 p1로 **복귀**할 때 터미널이 `connecting` + 백지로 **+3s**, 내용 복귀까지 **+15s**.
칩 탭도 동일하니 M6a 이전부터고, 730KB xterm 문서 재빌드가 pane 전환마다 통째로 일어나는 §CC의
잔여가 여기서 초 단위로 드러났다. **M6a는 통과했지만 사용성은 여기서 죽는다** — 별도 항목.

### M6c FAIL — 데이터는 멀쩡하고 크롬이 죽였다

**게이팅 질문 해소: 서버 버퍼는 비어 있지 않다.** 앱을 거치기 전에 CLI로 갈랐다 —
`pane read --source recent-unwrapped --lines 1000` = **301줄**(LINE-1~300), 같은 pane `visible` = 28줄.
272줄 이상이 서버에 실재한다. "앱 결함"과 "서버에 없음"이 섞이지 않았다.

오버레이도 **정상 렌더**됐다: `301 lines · read 16:36:18`이 서버 카운트와 정확히 일치, 라이브 뷰포트가
27행(LINE-275~299)인데 오버레이는 LINE-1과 원본 명령줄까지 도달, 목업 픽스처 문자열 0건,
**Android 세로 스크롤 동작**(ScrollView가 WebView 밖이라 깨끗 — 예측이 맞았다).

**죽은 것은 닫기다.** `PaneHistoryOverlay.tsx:123-132`이 `StyleSheet.absoluteFillObject` + 평면
`paddingTop: 16`뿐이고 `useSafeAreaInsets`를 부르지 않는다. 그래서 `Refresh`/`Close`가 실측 **y≈53–86**,
Android 상태바 아래에 깔린다 — y 6점(70·74·75·78·84·95) 스윕 전부 무반응, 반면 라이브 헤더의
`History`(y=169)는 정상. 유일한 탈출구인 back 키는 오버레이가 아니라 **터미널 화면 전체를 pop**한다.

### 이것은 §D1의 재발이다

`src/layout/safe-area-chrome.ts`가 자기 헤더에 §D1을 이렇게 적어놨다: *"Every screen's own top bar
hardcoded `paddingTop: 24`"*. 이 오버레이는 `16`을 하드코딩했다. **같은 결함 계열, 한 화면 뒤.**
윈도 가장자리에 고정되는 표면을 새로 만들 때마다 재발할 수 있다는 뜻이다.

### 수리 (이 커밋)

- `PaneHistoryOverlay`가 **`topPadding` prop**을 받는다. `useSafeAreaInsets()`를 직접 부르지 않은 것은
  두 가지 이유다 — 이 컴포넌트의 doc이 약속한 *"reads no context"*(마운트 스위트가
  `SafeAreaProvider` 없이 렌더)를 지키고, 라이브 헤더와 **같은 수 하나**임을 구조로 강제한다
  (이 오버레이는 그 헤더가 있던 자리를 덮는다).
- 라우트가 `safeChromePadding(insets.top, HEADER_TOP_PADDING)` — 라인 276이 자기 헤더에 쓰는
  **바로 그 식**을 넘긴다.
- `styles.header`에서 **`paddingTop`을 아예 없앴다.** 평면 상수가 다시 기어들어올 자리를 없앤 것이
  주석보다 강한 게이트다.
- 기계화: `src/app-shell/safe-area-mount.test.tsx`(=§D1의 테스트)에 오버레이 4건 추가 —
  버튼 2종 × (iPhone 세로 / Android). RED 확증: 되돌리면 정확히 그 4건만 깨지고, 랜드스케이프
  바닥 가드는 양쪽에서 통과.

### 아직 못 본 것 (FAIL이 아니라 판정 불가)

- **B8 캐시** — 마운트를 유지한 채 닫고 재진입해야 재는데 `Close`가 안 눌려 막혔다. 관측된 새 exec
  (`16:36:18`→`16:39:19`)는 **화면 전체 언마운트 후** 재진입이라 예상된 값이지 위반 증거가 아니다.
- **`Refresh`의 두 번째 exec** — 같은 이유.

둘 다 이 수리로 판정 가능해진다.

---

## GG. M6c PASS — 수리가 닫았고, 2차에 막혔던 두 질문도 함께 답했다 (2026-08-23, 별도 에이전트, `qa-m6c` @ `cde4eb2b`)

APK 16:54:14 / 커밋 `cde4eb2b`. 워크트리는 시작과 끝 모두 porcelain clean.
live 판정, 난수 토큰 3종: `QAM6C-a85b648aad38`(300줄 픽스처) ·
`LIVEUPD-4a50d3af21`(오버레이 열린 동안 찍음) · `AFTERCLOSE-f5296d3c39`(닫은 뒤 찍음).
픽스처 pane **1개**, 줄 폭 56자, tmux 호스트 윈도 200×50, herdr `viewport_rows: 49`,
스크롤백 300줄 방출 → `recent-unwrapped` 301행에서 시작해 313행까지 증가.

### 근인 수리가 실제로 버튼을 꺼냈다

| 측정 | 2차 (`264b4479`) | 3차 (`cde4eb2b`) |
|---|---|---|
| `Close`/`Refresh` 중심 y | **53–86** (상태바 아래) | **168–169** |
| 탭 성공 | y 6점 스윕 전부 실패 | 5회 전부 성공 (History ×2, Refresh ×2, Close ×1) |
| 탈출 수단 | back 키뿐 (화면 전체 pop) | back 키 불필요 |

`+95px` 이동. 1080×2400 @420dpi 기기 픽셀 스캔.

### 2차에 "판정 불가"로 남았던 둘이 닫혔다

- **`Refresh`가 실제로 다시 읽는다** — `read 17:02:31 → 17:03:23 → 17:04:57`,
  `302 → 309 → 313 lines`, 그 사이 서버에 찍힌 `LIVEUPD`/`AFTERCLOSE`가 차례로 유입.
  2차엔 `16:39:19`이 불변이었다.
- **B8 캐시 성립** — 마운트를 유지한 채 닫고 재진입하니 `read 17:03:23 · 309 lines` **불변**이고,
  그 사이 서버에 찍힌 `AFTERCLOSE-f5296d3c39`가 **안 보인다**. 그리고 직후 `Refresh`가
  `313 lines · 17:04:57`로 그 내용을 가져와 **"서버에 없어서 안 보인 게 아님"까지** 확증했다.
  이 두 번째 절반이 없으면 캐시와 빈-서버가 구분되지 않는다.

### 닫으면 라이브가 살아 있다 — 언마운트가 아니다

오버레이가 덮고 있는 동안 원격 pane에 찍힌 `LIVEUPD-4a50d3af21 NEW-1…6`이
**닫자마자 라이브 화면에 보였다.** 관찰 스트림이 끊기지 않았다는 뜻이고, 이것이 §Q의
재-attach 리시트가 기대는 성질이다. 오버레이 세로 스크롤도 회귀 없음(6회 상향 스와이프로
LINE-300대 → LINE-23~75 도달, 헤더·버튼 고정).

### ⚠️ 내 브리프의 용어가 부정확했다 — 판정자가 바로잡았다

내가 "**두 번째 exec**를 쓰는가"로 물었는데, 판정자는 **두 번째 *read*로만** 확증하고
ssh exec 채널 수준의 주장은 **어느 쪽으로도 하지 않았다**고 명시했다. 관찰된 것은
`remote-client-bridge` 프로세스가 내내 2개로 불변이라는 것뿐이다.

이 신중함이 옳다 — 그리고 **그 관측은 B8과 무관하다.** 세어진 것은 화면용 *bridge* 채널이고,
`pane.read`는 JSON API 채널로 간다(`JsonApiClient.call`). 즉 bridge 카운트 불변은 B8을
확증하지도 반증하지도 않는다. 캐시 질문에 실제로 답한 판별자는 `read <시각>` + 내용 유무이고,
그건 위에서 양방향으로 닫혔다. **B8의 exec-per-JSON-call 자체는 이 QA의 범위가 아니었다.**

### 못 본 것

`accessibilityLabel="Open pane history"` 문자열은 기기에서 못 읽었다 —
`uiautomator`가 앱 화면에서 텍스트 0개라, 보이는 라벨 `History`와 "누르면 열린다"로 대신했다.
라벨 문자열 자체는 소스·유닛에서만 검증됨.

---

## HH. iOS M6a FAIL — 그리고 내 리그가 조용히 다른 커밋을 서빙하고 있었다 (2026-08-23, 별도 에이전트, `qa-ios-m6` @ `264b4479`)

### ⚠️ 먼저: 리그 결함은 내 것이다

판정자가 시작하자마자 발견했다 — 설치된 앱의 **dev-launcher 최근목록이 `8081`을 최신값으로 갖고 있었고,
`8081`은 `qa-ios-m2b`(커밋 `105a2ea5`)다.** 앱을 install하고 Metro를 8086에 띄우는 것만으로는
격리가 성립하지 않는다. 판정자가 `simctl openurl` 딥링크를 시도했으나 SpringBoard 확인창에 막혔고,
`recentlyopenedapps` plist의 타임스탬프를 직접 재작성해 8086을 최신으로 만든 뒤 재기동해서 해결했다.
**이후 증거만 판정에 썼다.**

`.prd/10`이 경고하는 그 함정을 **셋업 쪽에서** 내가 밟았다. 절차에 반영: iOS 리그는
"install + Metro"로 끝나지 않고 **앱이 실제로 그 포트에 붙었음을 확증**해야 완성이다.

### 판정: FAIL — 대조 실험이 이걸 "판정 불가"가 아니라 FAIL로 만들었다

제스처 합성은 성공했다. `idb`·`cliclick` 부재, `CGEvent` 주입은 Accessibility 미승인(보안 설정이라
켜지 않음)으로 막혔지만, **삭제된 `qa-ios-m2` 워크트리가 남긴 DerivedData에서 XCUITest 하네스를 복원**해
UI-test 타깃을 새로 만들고 `XCUICoordinate.press(forDuration:thenDragTo:)`로 실제 터치를 합성했다.

**같은 화면, 같은 드래그 파라미터(x 0.88→0.22, dur 0.15), 두 지점:**

| 지점 | 결과 |
|---|---|
| 단축키 행 (y=0.868, RN 가로 ScrollView) | **스크롤됨 −425.7pt** (17개 요소 이동) |
| 터미널 (y=0.35, `GestureDetector` 안) | **이동 0**, pane `w1:p1` 불변 (6초/35 샘플) |

즉 **가로 press-drag는 RN까지 확실히 도달한다.** 그런데 pane 스와이프는 발화하지 않는다.
합성 경로 3종(0.6s 느린 드래그 · 0.02s 플릭 · `swipeLeft()`) 전부 10초/20~26 샘플 동안 불변.
이동 ~426pt는 `activeOffsetX` 32와 커밋 임계 64를 크게 넘고, 수평 고정이라 `failOffsetY` 12에도 안 걸린다.

픽스처: tmux `-x 80 -y 52`, pane 3개(`27×26` / `27×25` / `27×51`), 칩 순서 = `pane list` 순서.
live 확증 = pane별 난수 토큰(`ZQ6A-ALPHA-042dbeb442` 등).

### 판정자의 위양성 자진 정정 (귀중하다)

초기 측정에서 `waitFor w1:p3 HIT 77ms` 같은 42~97ms 값이 나왔는데 **전부 거짓**이었다 —
XCUITest 요소 쿼리가 **칩 버튼 *내부*의 static text `w1:p3`에 매칭**됐다(`debugDescription`이
그 자식을 접어 보여주지 않는다). 원자적 스냅샷 기반으로 바꾸자 헤더는 한 번도 안 변했다.
**이 수치를 지연으로 보고했으면 "iOS가 Android보다 빠르다"는 허구가 원장에 남을 뻔했다.**

### 근인 — 판정자의 가설은 코드와 어긋난다. 진짜 후보는 다른 줄이다

판정자는 **[가설]**로 *"WKWebView 내부 recognizer가 터치 스트림을 선점"* 을 지목했다.
그 문장이 이름 붙인 recognizer는 스크롤뷰의 pan인데, **코드가 그걸 이미 껐다**:

- `src/terminal/TerminalWebView.tsx:428` — **`scrollEnabled={false}`**. `:451` 주석이 이유까지
  적어놨다("Nothing here needs it"). 스크롤뷰 pan은 애초에 경합 대상이 아니다.

읽어서 나온 실제 후보는 **페이지 자신**이다:

- `src/terminal/terminal-webview-html.ts:1754` — `touchmove` 리스너가 **무조건**
  `e.preventDefault(); e.stopPropagation();` 를 부른다(`term`이 있고 dispatcher가 안 막으면 항상).
- 그리고 그 아래 `:1780`은 **가로 팬을 "내용이 뷰포트보다 넓을 때만"** 처리한다 — 즉 **fit 폭에서는
  페이지가 아무 것도 안 하면서 preventDefault만 하고 있다.** `pane-swipe.ts` 헤더가 설계 시점에
  적어둔 *"At fit width — every unzoomed pane — a horizontal drag does nothing today"* 가
  바로 이 상태다.

**플랫폼 비대칭이 이 그림과 맞는다 [가설]**: Android는 RNGH 루트 뷰가 네이티브 층에서 가로채므로
페이지의 `preventDefault`가 영향을 못 준다(§DD에서 실측 — 활성화 시 루트가 자식으로 전달을 멈춘다).
iOS는 WKWebView가 페이지의 touch 처리 결과를 기다리는 구조라, 페이지가 소비를 선언하면 바깥
recognizer가 못 가져간다. **이건 코드에서 유도한 가설이지 내가 증명한 인과가 아니다.**

### 다음 행동 — 추측으로 고치지 않는다

계측을 먼저 넣는다: pan의 `onBegin`/`onStart`/`onEnd`가 iOS에서 **한 번이라도 발화하는지**.
그게 갈리기 전에는 "recognizer가 활성화 못 함"과 "활성화 후 규칙이 기각"이 구분되지 않는다.
후보 수리(가로 우세 + fit 폭이면 `preventDefault`를 건너뛴다)를 같은 빌드에 얹어 한 사이클에
①메커니즘 확정 ②수리 검증을 함께 받는다.

### 못 본 것 (FAIL과 구분)

전환이 0이므로 **전환 지연·양 끝 no-op은 측정 대상이 없다**. **수직축 보존은 공허한 통과** —
수직 후 불변이지만 수평도 불변이라 터미널이 수직을 실제로 소비했는지는 미증명.
**재연결 부재**는 스와이프 구간 `Accepted publickey` 증분 0으로 관측됐으나, 리타겟이 없었으니
§2.3을 실제로 시험한 것은 아니다. 시뮬레이터 한정 — 실기기에서 경합이 다를 가능성 배제 못 함.

---

## II. iOS M6c PASS — 7/7, 그리고 §D1과 똑같이 생긴 위양성 하나 (2026-08-23, 별도 에이전트, `qa-ios-m6c` @ `a277ec0f`)

**포트 결속 확증부터** (§HH가 만든 요구사항): 앱 접근성 트리에 `Connected to:, http://127.0.0.1:8088`이
그대로 찍혔고, `curl :8088` 매니페스트의 `projectRoot`가 이 워크트리, Metro 8088 로그에 이 워크트리의
번들 요청이 흐른다. **다른 포트 관측 0.** §HH의 리그 결함이 반복되지 않았다.

픽스처: pane **53컬럼 × 51행**, 워크스페이스 1 / 탭 1 / pane 1, 스크롤백 **300줄**(`FIXLINE 001–300`)
→ 서버 `recent-unwrapped` 302행. 뷰포트 51행이라 **001–251이 화면 밖**.
live 확증 = 난수 토큰 3종(`e32d7df380` 픽스처 · `7ad8a18a6a` 오버레이 중 유입 · `a21ee8b4d0` 닫기 직전 유입),
목업 문자열 `scrolled-off` grep 0건.

### 수리가 iOS에서도 정확히 의도한 수를 냈다

`Close` frame **y=62.0** = iPhone 17 Pro Max의 **top inset 62pt와 정확히 일치**.
`safeChromePadding = Math.max(inset, 16)`이 설계대로 inset을 골랐다는 뜻이고, Android(24dp → y≈169,
§GG)와 iOS(62pt → y=62)가 **같은 식에서 서로 다른 올바른 값**을 냈다.

| 항목 | 증거 |
|---|---|
| Refresh 재읽기 (2회 독립) | `302 lines·17:32:02` → `308·17:33:55`(토큰 `7ad8a18a6a` 0→12건) → `312·17:40:30`(`a21ee8b4d0` 0→8건) |
| 오버레이 렌더 | 라이브는 252행부터인데 오버레이엔 `FIXLINE 001`부터 전량, meta 302 = 서버 302 일치 |
| 세로 스크롤 | 표시 구간 248–300 → 185–241 |
| 닫은 뒤 라이브 | 오버레이가 덮은 동안 찍힌 `MIDLINE×5` + `CLOSELINE×3`이 닫자마자 전부 렌더, 커서 살아있음 |
| B8 캐시 | 마운트 유지 재진입에서 `308·17:33:55` 불변 + `a21ee8b4d0` 0건 → 직후 Refresh가 `312·17:40:30` + 8건 |

B8은 Android 판정자가 세운 **양방향 형태**(불변을 본 뒤 Refresh가 그 내용을 실제로 가져오는 것까지)를
그대로 만족했다. 캐시와 빈-서버가 갈렸다.

### ⚠️ 하네스 위양성 — expo-dev-client의 기어 FAB (제품 결함 아님)

`Close`(x 375–424, y 62–85) 탭이 **3회 연속** dev-client의 Tools FAB(≈(398,108)pt)에 가로채여
개발자 메뉴가 열렸다. **XCUITest는 `isHittable=true`로 보고하는데 탭은 FAB로 갔다** —
*"탭은 전달되는데 아무 일도 안 일어난다"* 는 §D1의 증상과 **겉모습이 똑같다.**
개발자 메뉴에서 Tools button 스위치를 끈 뒤(라벨이 아니라 스위치 프레임 좌표로) 첫 시도에 성공.
릴리즈 빌드엔 이 FAB가 없다.

이게 §HH와 겹쳐 읽히는 게 중요하다: iOS에서 *"탭/드래그는 갔는데 반응 없음"* 은 **최소 세 가지**다 —
①safe-area 매몰(§D1/§FF) ②dev-client FAB 가로채기(여기) ③제스처 recognizer 경합(§HH).
**증상만으로 셋을 구분할 수 없다.** 판별자는 각각 실측 y · 무엇이 열렸나 · 대조 실험이다.

### 못 본 것

iPhone **17 Pro**(inset 59pt)는 미측정 — 다른 에이전트가 쓰던 기기라 손대지 않았다. 표현식이 같은
경로이므로 회귀 위험은 낮으나 **59라는 수치 자체는 판정 불가**. 가로 회전·릴리즈 빌드 거동 미측정.

---

## JJ. iOS M6a 2차 FAIL — 계측이 답했다: 터치가 recognizer에 **한 번도** 안 온다 (2026-08-23, 별도 에이전트, `qa-ios-m6a2` @ `f7547261`)

### 계측 결과 — 이게 이 라운드의 산출물이다

| 신호 | 7회 시도 |
|---|---|
| `[paneSwipe] begin` | **7/7** |
| `[paneSwipe] start` | **0/7** |
| `[paneSwipe] finalize` | 7/7 — 전부 `success=false` **`dx=0 dy=0`** |

**`dx=0 dy=0`이 결정적이다.** "±32 활성화 임계에 못 미쳤다"가 아니라 **pan recognizer가
`touchesMoved`를 단 한 번도 못 받았다**는 뜻이다. 브리프의 판별표에서 "`begin`만" 행이고,
그보다 더 날카롭다.

**따라서 이번 빌드의 수리(페이지 쪽 `preventDefault` 양보)는 아무것도 바꾸지 않았고, 그 사실 자체가
진단이다** — 파손 지점은 문서의 터치 핸들러보다 **위**, 네이티브 recognizer 사슬에 있다.
페이지가 무엇을 선언하든 도달하지 않는 이벤트를 양보할 수는 없다.

합성 4종(press+drag 0.15s / 속도 플릭 vel 1200 / 슬로우 롱드래그 1.0s / 네이티브 `app.swipeLeft()`)
전부 동일. 대조군은 같은 화면 RN 가로 ScrollView를 **−221.7pt** 이동시켰다.
픽스처 pane 3개(≈40컬럼), 칩 순서 p1·p3·p2, live 확증 = pane별 난수 토큰(`TOKEN-e193f52059` 등).

### ⚠️ 이걸 제품 결함으로 확정하면 안 된다 — 판정자가 스스로 남긴 잔여

> 대조군은 **WKWebView 뒤에 있지 않은** RN ScrollView를 움직였다. XCUITest 드래그가
> WKWebView 위에서 조상 `UIGestureRecognizer`로 move를 전파하지 않는 것뿐이라면,
> `dx=0`은 **합성의 성질**이지 제품 결함이 아니다.

독립 리그 2개(1차 `qa-ios-m6` · 2차 `qa-ios-m6a2`)가 동일 결과에 도달했지만 **둘 다 XCUITest**다.
같은 도구의 같은 한계는 두 번 나타나도 한 번의 증거다.

### 다음 행동 — 제품이냐 하네스냐를 가르는 값싼 실험

**페이지 자신의 `touchmove`가 그 드래그 동안 발화하는가.**

| 관측 | 결론 |
|---|---|
| 페이지 `touchmove` 발화 O, recognizer `dx=0` | 터치는 WKWebView에 도달하는데 조상으로 안 올라간다 → **제품 결함**, UIKit 제스처 사슬 |
| 페이지 `touchmove` 발화 X | XCUITest가 그 표면 위에서 move를 안 만든다 → **하네스 한계**, iOS M6a는 시뮬레이터로 판정 불가 |

Android는 이 질문을 CDP로 답했다(§DD의 touchstart/touchmove/touchend 카운트). **iOS엔 CDP가 없으므로
페이지가 스스로 세어 RN 브리지로 보고해야 한다.**

두 번째 결과가 나오면 iOS M6a는 FAIL이 아니라 **실기기 대기**로 이동한다 — iOS M4와 같은 게이트다.

### 부수 수확 — dev-launcher 재결속에서 통한 것과 안 통한 것

§HH가 만든 "8089 결속 확증" 요구가 **또 발동했다**: 최초 상태가 **8086**(1차 QA 워크트리)이었다.

| 방법 | 결과 |
|---|---|
| `simctl spawn <UDID> defaults write` | **무효** — 앱 컨테이너가 아니라 **디바이스 전역** plist에 쓴다 |
| 컨테이너 plist의 `expo.devlauncher.recentlyopenedapps` 재작성(binary plistlib + cfprefsd kill) | **무효** — 그 키는 자동 재결속 레버가 아니다 |
| **`simctl openurl <UDID> "herdr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8089"`** | **통함.** 앱이 이미 포그라운드면 SpringBoard 확인창도 안 뜬다 |

1차 판정자의 plist 재작성이 통했다는 §HH의 기록은 **이 라운드에서 재현되지 않았다** — `.prd/10`의
권고를 openurl 우선으로 바꾼다.

### 못 본 것 (FAIL과 구분)

전환이 0이라 **전환 지연·양 끝 no-op은 대상 없음**. **수직축 보존도 판정 불가** — 수평이 안 되는
상태에서 "수평 되고 수직 안 됨"을 볼 수 없다(수직도 `dx=0 dy=0`이고 스크롤백도 안 움직였으나
공허한 통과로 쓰지 않았다). **오버플로 팬 회귀도 판정 불가** — 핀치가 WKWebView를 네이티브
텍스트선택 모드로 넣어 "그리드 > 뷰포트" 상태를 깨끗이 만들지 못했다. 양보 과잉 여부 미확인.

---

## KK. 판별 완료 — **제품 결함**이다. 그리고 내 수리는 발동조차 안 하고 있었다 (2026-08-23, 별도 에이전트, `qa-ios-m6a3` @ `a10475ea`)

### 판별자가 요구한 것보다 강한 대조군이 잡혔다

**같은 XCUITest 드래그 · 같은 화면 · 같은 WKWebView 프레임**인데 페이지의 청취 여부만 다르다:

| 상태 | `[touchProbe]` | `[paneSwipe]` | pane 전환 |
|---|---|---|---|
| mock / `no transport` — 페이지가 **안 듣는** WKWebView | start 0 / move 0 | begin 3 / start 2 / **dx=−229 success=true** | **됐다** |
| live / `Connected` — 페이지가 **듣는** WKWebView | start 3 / first-move 3 / end 3 (moves **53·98·27**) | begin 3 / start **0** / **dx=0 dy=0** | 안 됐다 |

**"하네스 한계" 가설은 죽었다.** XCUITest는 이 표면 위에서 move를 만든다 — 페이지가 안 잡을 때는
조상 recognizer가 dx=−229를 받고 전환까지 커밋했다. 2차 판정자가 남긴 잔여("대조군이 WKWebView 뒤가
아닌 RN ScrollView였다")도 함께 닫혔다. **이번 대조군은 같은 WKWebView다.**

**판정: 제품 결함.** 페이지는 제스처당 53·98·27개의 touchmove를 실제로 셌는데 조상 pan recognizer는
그중 **단 한 개도** 못 받았다. 터치는 WebView에 도달하지만 UIKit 제스처 사슬로 올라가지 않는다.
부수 확증: `touchend`가 3/3 발화 — §DD의 Android 실측("활성화된 recognizer는 전달을 멈춰 touchend 0")과
**반대**이므로, recognizer가 제스처를 가져간 적이 없다는 독립 증거다.

**한 줄 요약: M6a는 "터미널이 살아 있을 때만" 죽는다.**

### 그리고 판정자가 내 수리의 결함을 짚어줬다 — 그게 이 항목의 본론이다

`f7547261`의 양보 규칙은 이 픽스처에서 **한 번도 발동하지 않았다**. 가드가

```js
if (getContentWidth() * getTotalScale() > window.innerWidth + 1) return false;
```

인데 **80컬럼 pane이 402pt 뷰포트에서 이미 이 조건을 만족**한다. 판정자는 여기까지 짚었고,
근인은 코드에 있다 — `commitFitScale`:

```js
var preSnapScale = computeFitScale();   // min(1, vpWidth / termWidth)
currentScale = preSnapScale;
if (currentScale >= 0.95) currentScale = 1;   // ← 스냅
```

**0.95~1의 fit을 정확히 1로 스냅한다.** 그래서 *반올림 후에는* 맞는 pane이 "내용이 뷰포트보다 넓음"을
보고하는데 **독자는 아무것도 확대하지 않았다.** 이 상태는 이미 이 파일이 이름 붙여놨다 —
바로 아래 `suspect` 체크가 `currentScale === 1 && expectedW > vpW + 1`이다.

즉 **내 가드는 "페이지가 팬을 한다"의 대용물로 넓이 산술을 썼고, 스냅이 그 대용물을 상시 참으로
만들었다.** 평범한 pane 전부에서 양보는 죽은 코드였다.

### 수리

가드를 **`userScale > 1`** 로 바꿨다 — "독자가 실제로 확대했는가". 포기하는 것: 스냅된 pane이 쉬는
상태에서 반올림이 남긴 몇 픽셀의 팬. 그 여유는 pane 전환보다 값이 낮고, 설계가 이미 그렇게 말했다
(`pane-swipe.ts`: *"At fit width — every unzoomed pane — a horizontal drag does nothing today"*).

테스트도 **술어 자체**를 고정하도록 바꿨다. §KK의 교훈이 "산술 형태로 되돌아가면 수리가 조용히
사라진다"이기 때문이다 — 기기 테스트가 못 잡은 것이 정확히 그거였다.

### ⚠️ 아직 열려 있는 것 — 다음 라운드의 질문

**양보가 실제로 발동했을 때 recognizer가 move를 받는가.** 두 갈래가 남아 있다:

| 관측 | 결론 |
|---|---|
| `dx`가 0이 아니게 됨 | `preventDefault` 호출이 전파를 막던 것 → **수리 완료** |
| 여전히 `dx=0` | **비수동 리스너의 존재 자체**가 막는 것(`touchmove`는 `{capture:true, passive:false}`) → JS로는 못 고치고 네이티브 수리가 필요 |

두 번째면 수리 지점은 RNGH의 iOS `simultaneousWithExternalGesture` 계열이거나 WKWebView recognizer
쪽이고, 그건 이 문서가 아니라 네이티브 층 작업이다.

### 부수 — 판정자 자진 신고 (내가 검증했다)

정리 중 `herdr server stop`이 격리 XDG가 아니라 **유저 소켓 경로**로 해석됐다. 멈추지는 못했고
(15초 타임아웃), 판정자가 유저 데몬 생존을 사후 확인했다. **내가 재확인**: pid 8329 생존(경과 1일 7시간),
`~/.config/herdr/herdr.sock` 정상, `herdr server` 프로세스 18개. `pkill -f herdr`는 쓰이지 않았다.
자진 신고가 정확했다. **랩 정리는 PID 지정으로만** — `.prd/10`에 이미 있는 규칙이 한 번 더 확인됐다.

---

## LL. iOS M6a 4차 — `dx`는 여전히 0. **비수동 리스너 등록 자체**가 범인이다 (2026-08-23, 별도 에이전트, `qa-ios-m6a4` @ `723a392e`)

§KK가 세운 2지선다에 답이 나왔다. 판정자가 **양보의 전제가 충족됐음을 실측으로 보이고** 그래도 안 됐다:

- `userScale = 1` (S1–S4 내내 손대지 않음), 드래그 `|dx| ≈ 313px`, `|dy| = 0`, 임계 32px / 1.5 비율
  → `shouldYieldHorizontal`이 참 → **`preventDefault`는 건너뛰어졌다**
- 그런데 페이지는 여전히 touchmove **63개**를 셌고, 조상 recognizer는 **여전히 0개**를 받았다
- 6/6 제스처 전부 `dx=0 dy=0`, `[paneSwipe] start`는 **한 번도** 안 찍힘 (begin/finalize만)

**결론: `preventDefault` *호출*이 아니라 `{capture:true, passive:false}` *등록 자체*가 전파를 막는다.**
비수동 touchmove 리스너는 WebKit이 페이지의 응답을 기다리게 만들고, 그 대기가 조상
`UIGestureRecognizer`로의 전달을 죽인다.

판정자가 서빙된 번들(17MB)을 직접 받아 grep해 **앱이 수리된 코드를 돌렸음**을 확인했다
(`userScale > 1` ×1, `shouldYieldHorizontal` ×3). stale 번들이 아니다.
대조: **칩 탭은 전환된다**(`w1:p1`→`w1:p2`, 토큰 확인) — pane 전환 자체는 살아 있고 제스처만 죽었다.
픽스처 80컬럼 × 2 pane, 스크롤백 120줄, pane별 다른 토큰(`ZALPHA2DF529` / `ZBRAVO-74071D`, 교차 0건).

**부수 PASS 2건**: 확대 상태 회귀 없음(핀치 줌인 성공 — 3차의 텍스트선택 콜아웃 **재발 안 함** —
그리고 줌 상태 가로 드래그가 여전히 페이지를 팬). 재연결 부재(연결 1건을 전 구간 유지, exec 289건이 그 위).

### 수리 — `preventDefault`를 CSS로 대체하고 리스너를 수동으로

페이지는 브라우저 기본 터치 동작 억제를 **전적으로 `preventDefault`에 의존**하고 있었다 —
`touch-action`이 문서에 **한 줄도 없었다**. 그게 비수동 등록을 강제한 이유다.

| 이전 | 이후 |
|---|---|
| `touch-action` 없음 | `html, body { touch-action: none; -webkit-touch-callout: none; }` |
| `touchmove` `{capture:true, **passive:false**}` | `{capture:true, **passive:true**}` |
| 핸들러가 `e.preventDefault()` 호출 | 호출 제거 (`stopPropagation`은 유지 — 수동 리스너에서도 동작하고, xterm 자체 핸들러를 막는 건 그쪽이다) |

`touch-action: none`은 같은 말을 **선언적으로, 미리** 한다 — 그래서 붙잡을 것이 없다.
`-webkit-touch-callout: none`은 `preventDefault`가 곁다리로 억제하던 것을 덮는다(3차가 밟은 Copy/Select All 콜아웃).

**이 수리는 브라우저를 돌리지 않는 이 레포의 어떤 테스트에도 안 보인다** — 선언 2개와 등록 플래그 1개뿐이다.
그래서 셋 다 테스트로 고정했다. 하나라도 조용히 되돌아가면 결함이 스위트 green인 채로 부활한다.

### ⚠️ 이 수리는 Android 회귀 위험을 만든다

Android M6a·M6c는 **PASS 상태**이고 둘 다 이 터치 경로 위에 있다. iOS 재QA가 통과하면
**Android 두 항목 재QA가 필수**다. iOS가 또 FAIL이면 이 변경은 이득 없이 위험만 남으므로
되돌리고 네이티브 작업(RNGH iOS `simultaneousWithExternalGesture` 계열 / WKWebView recognizer)으로 넘긴다.

### 이번 라운드에 내가 만든 결함 2종 (같은 실수의 반복)

1. **템플릿 리터럴 안 주석의 백틱** — 세 번째다. `XTERM_HTML` 안에서 식별자를 백틱으로 감싸면
   문자열이 끊기고 파싱이 엉뚱한 곳에서 죽는다. `terminal-webview-html.ts` **헤더에 경고를 박았다** —
   다음 편집자가 실제로 서 있을 자리다.
2. **`indexOf`로 구간 자르기** — 끝 마커가 시작보다 앞에 있어 빈 슬라이스가 나오고, 그러면
   `not.toContain`이 전부 **엉뚱한 이유로 통과**한다. 이 파일에서만 두 번 냈다.
   fromIndex + `expect(len).toBeGreaterThan(0)` 가드를 넣었고, 그래도 마커가 **다른 모듈의**
   리스너를 잡아서, 결국 주장의 대상 모듈(`TERMINAL_TOUCH_PAN_JS`)에 직접 검사하도록 바꿨다.
   **문서에서 잘라내지 말고 주장하는 모듈을 읽어라** — 그게 교훈이다.

---

## MM. iOS M6a 5차 — 수리는 옳았는데 **한 모듈에만** 적용됐다 (2026-08-23, 별도 에이전트, `qa-ios-m6a5` @ `0f2fc4bc`)

`dx=0`이 14/14로 유지됐다. 판정자가 이유를 정확히 짚었다.

### 내가 절반만 고쳤다

§LL은 `TERMINAL_TOUCH_PAN_JS`만 수동으로 돌렸다. 그런데 같은 문서가
`terminal-webview-tap-dispatch-injected.ts:113`에서 **`document`에** touchmove를
`{capture:true, passive:false}`로 **계속 등록**하고 있었다(`:57`의 touchstart도 같다).

**`document` 레벨 capture 리스너는 `targetSurface` 것보다 먼저 발화한다.** 그러니 §LL이 확정한
기제 그대로 WebKit은 여전히 모든 터치를 붙잡았고, 표면 모듈만 바꾼 것은 **아무것도 바꾸지 않았다.**

### 그리고 내 테스트가 그걸 green으로 통과시켰다

`expect(TERMINAL_TOUCH_PAN_JS).not.toContain('passive: false')` — **한 모듈에 스코프**돼 있어서,
같은 문서에 비수동 등록 2개가 살아 있는데도 통과했다. 판정자의 표현이 정확하다:
**"assert the wrong scope 함정의 뒤집힌 형태"**. §LL 커밋 메시지가 경고한 바로 그 실수를,
경고를 쓰면서 저질렀다.

### 이번 수리

- `terminal-webview-tap-dispatch-injected.ts`의 **document 레벨 touchstart·touchmove 둘 다 passive**로.
  거기 있던 `preventDefault` 2건은 **select-drag(선택 핸들 드래그) 모드에서만** 쓰였고,
  그건 `touch-action: none`이 이미 덮는다.
- `terminal-webview-wheel-scroll-injected.ts:54`의 `passive:false`는 **그대로 둔다** —
  `wheel`은 터치 이벤트가 아니라 터치를 붙잡을 수 없다.
- **테스트를 문서 전체 스캔으로 교체**: 서빙된 문서의 모든 `addEventListener('touch…')` 등록을
  찾아 옵션에 `passive: false`가 있으면 실패. 게다가 **스캔이 아무것도 안 찾는 것 자체를 실패**로
  만드는 두 번째 테스트를 붙였다(등록 철자가 바뀌면 스캔이 조용히 빈 결과를 내고 통과한다).
  RED 확증: 하나를 되돌리면 스캔이 잡는다.

### 회귀 3항목은 이 라운드에서 통과했다 (귀중하다)

| 항목 | 결과 |
|---|---|
| 핀치 줌 | **된다** — 3.5× 확대 확증(스크린샷 해시 상이, 화면에 거대 글자) |
| 줌 상태 가로 팬 | **된다** — 화면 이동, 헤더는 `w1:p1` 유지 |
| 텍스트선택 콜아웃 | **안 뜬다** — 1.6s 롱프레스 후 menuItems 0개. `-webkit-touch-callout: none` 유효 |

즉 `preventDefault` 제거의 대가는 지금까지 **0**이다. 남은 두 모듈을 마저 돌리는 비용이 낮은 이유다.

### 수직 스크롤백은 회귀가 아니라 **판정 불가**다 — 판정자의 정직함

페이지가 63~88개 move를 받았는데 화면이 안 움직였다. 그런데 판정자가 그걸 회귀로 부르지 않았다:
`panY`는 **2-touch 핀치 분기에서만** 갱신되고 단일 손가락 수직은 `term.scrollLines`에 위임되는데,
**앱의 로컬 xterm은 원격의 24행 뷰포트만 보유한다**(그게 M6c 히스토리가 존재하는 이유다).
즉 이 픽스처엔 `scrollLines`가 움직일 로컬 스크롤백이 애초에 없다.
"이 커밋이 깼다"와 "원래 no-op이었다"를 가르려면 수리 전 대조 빌드나 alt-screen 픽스처가 필요하다.

### 남은 위험은 그대로다

Android M6a·M6c가 **PASS 상태**이고 둘 다 이 터치 경로 위다. iOS가 통과하면 **Android 2항목 재QA 필수**.
iOS가 또 FAIL이면 이 변경은 이득 없이 위험만 남으므로 되돌리고 네이티브 작업으로 넘긴다.

---

## NN. iOS M6a 6차 — **`dx`가 시작 y에 따라 갈린다.** 경계는 도색 영역의 끝이었다 (2026-08-23, 별도 에이전트, `qa-ios-m6a6` @ `a869cf23`)

이 라운드가 근인을 좌표로 못 박았다.

| 드래그 시작 y | `[paneSwipe]` | `[touchProbe]` | 전환 |
|---|---|---|---|
| 200 / 300 / 400 (**글자 위**) | `success=false` **dx=0 dy=0** | start·first-move·end (moves 20~40) | 없음 |
| 500 / 600 / 680 (**마지막 행 아래 공백**) | `begin→start→finalize` **success=true dx=−295** | **0건** | **됐다** |

**누름 시간은 판별자가 아니다** — y=400 고정, hold 0.05~0.50 매트릭스 5회 전부 dx=0.
스크린샷 실측상 마지막 도색 행은 **y≈482**. 경계가 정확히 거기다.

공백에서의 전환은 완전히 정상이었다: 좌 p1→p3→p2, 우 p2→p3→p1(칩 순서 일치), **양 끝 no-op ×2씩**
(`success=true`인데 `[fit]renderer` 없음 = 제스처는 인식, 방향만 거부), 재연결 0(같은 소켓 :52549 유지).

### 근인 — 판정자가 스스로 "잔존 구멍"으로 적어둔 그 줄이다

`terminal-webview-mouse-click-drag-injected.ts:197`:

```js
targetSurface.addEventListener('touchstart', function() { … }, true);   // ← 옵션 객체 없음
```

**레거시 boolean-capture 등록은 passive 플래그를 안 싣고, WebKit은 비루트 엘리먼트의 터치
리스너를 `passive: false`로 기본 처리한다.** 그리고 이건 `targetSurface`에 붙어 있는데
`#terminal-surface`는 `display: inline-block` — **정확히 도색된 그리드**다.

그래서 y 경계가 설명된다: 글자 위에서 시작하면 이 비수동 리스너가 경로에 있어 WebKit이 붙잡고,
마지막 행 아래에서 시작하면 그 엘리먼트가 경로에 없어 조상 recognizer가 −295를 받는다.
**§LL이 확정한 기제 그대로이고, 남은 마지막 등록 하나였다.**

판정자는 근인 후보로 *네이티브 텍스트 선택*을 지목했는데, 그건 이 경계를 설명하지 못한다 —
xterm 자체 CSS가 `.xterm { user-select: none }`이고 앱의 선택은 xterm API로 그린다.

### 내 스캔이 이걸 통과시킨 이유 — 두 번째 스코프 실패

§MM에서 만든 문서 전체 스캔은 등록 지점에서 `'}, {'`를 찾아 옵션 객체를 읽었다. 레거시 형태엔
그 객체가 없으므로 **`indexOf`가 한참 뒤 *다른* 등록의 옵션을 집어왔고**, 거기엔 `passive: false`가
없으니 통과했다. §NN에서 다시: **마커로 찾지 말고 다음 등록까지로 창을 닫아라.**

이제 창이 `passive`를 **한 번도 말하지 않는 것**도 `passive: false`와 똑같이 위반으로 잡는다.
RED 확증: 그 줄을 레거시 형태로 되돌리면 스캔이 잡는다(이전 판본은 못 잡았다 — 그것도 RED로 확인했다).

### ⚠️ 판정자의 "선택 콜아웃 FAIL"은 오귀속이다 — 정정

판정자가 접근성 트리에서 `Button 'Copy'` / `Button 'Select All'`을 보고 회귀 FAIL로 적었다.
**그 둘은 앱 자신의 선택 메뉴다** — `terminal-webview-html.ts:228-229`의
`<button id="sel-menu-copy">Copy</button>` / `<button id="sel-menu-all">Select All</button>`,
그리고 `:1057`이 그 기능을 이렇게 이름 붙여놨다: *"SELECTION MODE (long-press → handles → Copy)"*.

즉 같은 표의 **"선택 진입 + 핸들 드래그: PASS"와 동일한 기능**이고, 롱프레스 후 메뉴가 뜨는 것이
설계된 동작이다. 회귀 아님. (프레임 두 개가 같은 y에 66·93 폭으로 인접한 것도 `#sel-menu`의
flex row와 일치한다.)

### 남은 진짜 문제 — 전환 지연이 예산의 2.4~3.6배다

공백에서 전환이 성공한 경우의 실측: `finalize` → `[fit]renderer` **473 / 527 / 624 / 690 / 712 / 719 ms**,
헤더 텍스트 변경까지 633~913 ms. 그리드 `webgl, 94×39, vpWidth 402, scale 0.535`.
**기준 `<200ms`를 크게 넘는다.** Android는 스와이프분 184ms였고 나머지는 문서 재빌드분이었다(§FF).
iOS는 그 분해를 아직 못 했지만, §CC/§FF가 지목한 **pane 전환마다 730KB xterm 문서 전체 재생성**이
같은 자리에서 다시 나타난 것으로 읽힌다. **제스처가 고쳐져도 이 항목은 별도로 남는다.**

### 부수 — 유저 데몬을 또 겨눌 뻔했다

판정자 셸에 `HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`가 있어 랩 CLI가 **유저 프로덕션 서버**에
붙었고, 그 서버가 `protocol_mismatch` 에러로 **"`herdr server stop`을 실행하라"** 고 지시했다.
3차가 당한 바로 그 경로다. 판정자는 실행하지 않고 래퍼에서 소켓을 랩 경로로 오버라이드했다.
`.prd/10`의 unset 목록에 **`HERDR_SOCKET_PATH`를 추가**해야 한다 — `HERDR_ENV`/`HERDR_SESSION`만으로는 부족하다.

---

## OO. iOS M6a 7차 — **JS 레버 소진.** `passive`는 층이 틀렸다 (2026-08-23, 별도 에이전트, `qa-ios-m6a7` @ `30a8b83c`)

레거시 등록까지 고쳤는데 글자 위 `dx`는 여전히 0이다. 그리고 이번엔 **양쪽 계측이 서로를 완성한다**:

| 드래그 시작 | `[touchProbe]` (WebView 문서) | `[paneSwipe]` (RN) |
|---|---|---|
| y=200/300/400 (**글자 위**) | start → first-move → **end `moves:40`** | begin → **`success=false dx=0 dy=0`** (start 없음) |
| y=500 (**공백**) | **이벤트 0건** | begin → start → **`success=true dx=−295`**, 전환됨 |

**WebView는 40개 move를 전부 받고 RN은 0개를 받는다.**

### 근인의 최종 형태

`passive: true`는 **`preventDefault`를 제거할 뿐, WKWebView 자신의 pan recognizer가 UIKit 제스처
중재에서 이기는 것을 막지 못한다.** 글자 위에서는 WKWebView가 경합해 이기고, 글자 밖에서는
터치가 `targetSurface`(`display: inline-block`)에 닿지도 않아 경합 자체가 없어 RN이 이긴다.

**즉 수리는 네이티브 recognizer 중재여야 한다** — `scrollView.panGestureRecognizer`의
require-failure / simultaneity 설정, 또는 capture-phase claim. **JS에서 할 수 있는 것은 끝났다.**

서빙 번들 grep으로 확증됐다: WebView 문서 등록 9건이 전부 옵션 객체(`passive:true` ×8 + `wheel` ×1),
`targetSurface`의 레거시 boolean form **0건**. 번들에 남은 레거시 2건은 react-native 자신의
`HoverState`로 RN 런타임 쪽이지 이 문서가 아니다. **stale 배제.**

### 이번 라운드가 처음으로 답한 것들 (공백 구간 기준)

- **양 끝 no-op 통과** — p3에서 좌 2회, p1에서 우 1회 모두 헤더 불변. `finalize success=true dx=±295`인데
  `[fit]renderer`가 안 뜬다 = **죽은 제스처가 아니라 의도적 거부**. 이 구분이 중요하다.
- **선택·핸들 드래그 통과**(8줄 확장, 양쪽 핸들 + 앱 메뉴), **핀치 3× / 줌 상태 팬 통과**,
  **재연결 0**(`Accepted publickey` 2건 고정).
- 판정자가 §NN의 오귀속 정정을 이어받아 `Copy`/`Select All`을 **앱 메뉴로 올바르게** 읽었다.

### 전환 지연을 판정자가 분해했다 — 그리고 그게 별건임을 확정한다

| 구간 | 실측 |
|---|---|
| **스와이프분** | **≈ 0** — 커밋이 `[paneSwipe] finalize`와 **같은 틱**에 디스패치된다 |
| **문서 재빌드분** | `finalize` → 새 문서 `[fit]renderer` = **523 · 639 · 710 · 721 · 729 · 731 ms** (n=6, 중앙값 ~715ms) |
| 읽을 수 있는 새 pane까지 총합 | **~0.9–1.0 s** |

한 케이스에서 `[fit]renderer`(35.868)가 관측된 헤더 커밋(36.026)보다 **먼저** 왔다 —
**가시 지연 전체가 문서 재빌드에 지배된다**는 직접 증거다. 그리드 93×39, pane 3개, 스크롤백 142줄.

**즉 M6a의 제스처 예산은 문제가 아니다. 문제는 pane 전환마다 730KB xterm 문서를 통째로 다시 만드는 것이고,
그건 §CC에서 처음 지목돼 §FF에서 초 단위로 드러난 그 별건이다.** Android도 같은 항목에서
스와이프분 184ms / 본문 완전 페인트 716ms였다 — **양 플랫폼이 같은 곳에서 같은 값을 낸다.**

### 판정자가 "공허한 통과"를 거부했다

**수직축 보존 = 판정 불가.** 의미 있는 형태는 *같은 좌표에서 수평이 되는 상태*를 요구하는데
그걸 만들 수 없었다. 판정자는 공백(y=600) 수직 드래그가 전환을 안 일으킨 것을 두고
*"터치가 `targetSurface`에 닿지도 않아 '터미널이 갖는다'를 확증 못 함"* 이라며 **스스로 공허한 통과로 분류**했다.
브리프가 금지한 것을 판정자가 지켰다.

### 결정 — 되돌리지 않고 **측정**한다

§LL에서 나는 *"iOS가 또 FAIL이면 되돌리고 네이티브로 넘긴다"* 고 적었다. 그 약속을 그대로 집행하지
않는 이유를 남긴다:

- 되돌림의 명분은 **Android 회귀 위험이 미측정**이라는 것뿐이다. 그런데 그건 **되돌려도 측정해야 하고**
  (되돌림 자체가 변경이다), 측정하면 명분이 사라진다.
- iOS 7차가 회귀 4종(선택·핸들·핀치·줌팬)을 **전부 PASS**로 실측했다. 남은 미지는 Android뿐이다.
- 네이티브 수리는 비수동 리스너가 남아 있으면 **또 막힐 수 있다**. 되돌렸다가 재적용하는 것은
  같은 작업을 두 번 하는 것이다.

**그래서 Android 회귀 QA를 지금 돌린다.** 통과하면 이 변경은 네이티브 작업의 깨끗한 기반으로 유지되고,
회귀하면 그때 되돌린다. **미측정 위험을 측정으로 바꾸는 것이 되돌림보다 값이 크다.**

---

## PP. Android 회귀 스윕 — **없다.** §OO의 결정이 측정으로 닫혔다 (2026-08-23, 별도 에이전트, `qa-and-reg` @ `5d2e99d5`)

`passive`/`touch-action` 변경이 Android의 PASS 2건 위에 미측정으로 얹혀 있던 상태를 갈랐다.

| 블록 | 결과 |
|---|---|
| **A. M6a** | 좌 p1→p3→p2 / 우 역순(칩 순서 일치), 양 끝 no-op, 수직 보존(`dx=0 dy=19`인데 `touchProbe moves=17` = **터미널이 받았다**), 재연결 0 |
| **A. 지연** | **스와이프분 중앙값 184ms** (4회: 164/222/154/203) — **§FF와 같은 값**. 본문 정착 608–641ms로 §FF의 716ms보다 오히려 짧다 |
| **B. M6c** | History 버튼 y=169(§GG와 동일), 302줄 렌더·상단 도달, Refresh 302→308, 닫은 뒤 라이브 생존, **B8 캐시 양방향**(재진입 308 불변 → 직후 Refresh 312) |
| **C. 터미널 터치** | 선택·핸들 드래그 · 핀치(`scale 0.2527→2`) · 줌 팬(`translateX −1383→−1563` = 드래그 −180px 정확 일치) · 탭 전달 **전부 살아 있다** |
| **C. 문서 억제** | html·body 모두 computed `touch-action: none`, 대형 드래그·핀치 후 `visualViewport.scale 1` / `scrollTop·scrollLeft 0` |

**결정 확정: 변경을 유지한다.** §OO에서 "되돌림의 명분은 미측정 하나뿐"이라고 적었고, 그 명분이 사라졌다.
네이티브 작업(N1)은 이 기반 위에서 시작한다.

### 판정자가 하나를 회귀로 부르지 않은 것이 옳다 — 그리고 §CC가 그걸 이미 설명한다

**터미널 자체 수직 스크롤이 무동작**이었다. 판정자는 두 근거로 이 변경의 회귀가 아님을 보였다:
①CDP로 `.xterm-viewport`의 `scrollHeight == clientHeight == 777`, `scrollTop 0` — **클라이언트 xterm
버퍼에 스크롤백 행이 0**이다 ②이번 변경이 **비수동으로 남겨둔** `wheel` 경로로 6회 스크롤해도 무동작.

**그리고 이건 별건도 아니다 — §CC가 이미 구조로 확정한 사실이다.** `render_ansi.rs:613`이 셀마다
절대 커서 위치를 써서 터미널이 스크롤하지 않고 덮어쓰므로, **xterm 로컬 버퍼에는 애초에 쌓일 것이 없다.**
그게 M6c(서버 `pane.read` + 별도 오버레이)가 존재하는 이유다. 판정자는 §CC를 안 읽었으므로
"별건으로 남는다"고 적었는데, 원장에는 이미 답이 있다. **로컬 수직 스크롤은 깨진 게 아니라 없는 기능이다.**

단, 수직축 예약(`failOffsetY`)은 여전히 값이 있다 — alt-screen 스크롤이 **입력으로 라우팅**되는 경로
(`shouldRouteScrollToTerminalInput`)가 그 축을 쓴다. TUI 앱에서는 살아 있는 축이다.

---

## QQ. N1 후보 1의 막힌 지점이 열렸다 — `Gesture.Native()` (2026-08-23, 구현)

§OO는 N1(네이티브 recognizer 중재)의 후보 1을 이렇게 적어뒀다: *"RNGH `blocksExternalGesture(ref)` —
막히는 지점: `react-native-webview`의 `ref`는 `useImperativeHandle`이라 **네이티브 뷰 ref가 아니다**."*

**그 전제가 틀렸다.** `GestureRef`는 컴포넌트 ref만 받는 게 아니라 **`GestureType`(제스처 객체 자체)** 도
받는다(`gesture.d.ts:5`). 그리고 RNGH는 이 상황을 위한 기제를 이미 갖고 있다 — **`Gesture.Native()`**.

```
const terminalNativeGesture = useMemo(() => Gesture.Native(), [])

Gesture.Pan()
  …
  .blocksExternalGesture(terminalNativeGesture)   // 제스처 객체, ref 아님

<GestureDetector gesture={paneSwipe}>
  <View>
    <GestureDetector gesture={terminalNativeGesture}>   ← 이게 WebView 호스트에 붙는다
      <TerminalPaneView … />
```

**의미**: `Gesture.Native()`가 WebView 자신의 recognizer들에 RNGH가 부를 수 있는 이름을 준다.
`blocksExternalGesture`가 순서를 정한다 — **네이티브 쪽이 우리 pan의 실패를 기다린다.**
그 실패는 싸고 이르다(수직 ±12px, `pane-swipe.ts`) — 터미널은 자기 축을 전부 지키고 그만큼만 지연을 낸다.

내부 `GestureDetector`가 없으면 `blocksExternalGesture`가 **아무것도 이름 부르지 못한다** —
RNGH는 네이티브 제스처가 그 recognizer들을 대표하는 뷰에 마운트돼 있어야 한다.

### 이건 §OO의 "JS 레버 소진"과 모순되지 않는다

§OO가 소진됐다고 한 것은 **문서 안에서**(`passive`·`touch-action`·`preventDefault`) 할 수 있는
것이었고, 그 셋은 전부 출하됐는데 `dx`를 0에서 못 움직였다. 이건 **문서 밖, 네이티브 중재**를
JS API로 지시하는 것이다 — §OO가 "수리 지점은 네이티브다"라고 한 그 지점에, 네이티브 코드를
쓰지 않고 닿는 경로다.

### 게이트

**이 배선은 이 레포의 어떤 테스트에도 안 보인다** — 네이티브 recognizer 사이의 중재이고 여기선
아무도 네이티브를 안 돌린다. 그래서 테스트 더블이 `blocksExternalGesture` 호출을 **기록**하도록
확장하고(조용히 삼키면 중재를 멈춘 화면이 green으로 통과한다), 마운트 스위트가 배선의 존재를 고정한다.
게이트 107파일/919테스트, typecheck·lint·format 0.

### 미검증 — 다음 QA가 답한다

- **iOS**: 글자 위 y=200/300/400에서 `dx ≠ 0`이 되는가. 그게 §OO의 수용 기준이다.
- **Android**: `blocksExternalGesture`는 Android에서도 중재를 바꾼다. §PP가 방금 회귀 없음을
  확인한 그 경로 위라 **iOS가 통과하면 Android 재확인이 다시 필요하다.**

---

## RR. iOS M6a 8차 — `blocksExternalGesture`도 안 된다. **되돌렸다** (2026-08-23, 별도 에이전트, `qa-ios-m6a8` @ `bfee682e`)

§QQ가 연 줄 알았던 N1 후보 1이 닫혔다. 글자 위 `dx`는 **여전히 0**이고, 7차 표가 **그대로 재현**됐다.

| 좌표 | `[paneSwipe]` | `[touchProbe]` |
|---|---|---|
| y=200/300/400 (+ 500·560·620·660) | `success=false` **dx=0 dy=0** | moves **20~40** (WebView가 전부 수신) |
| y=680/690/700 | `begin→start→finalize` **dx=∓295**, 전환 정상 | **무음** |

판정자가 서빙 번들에서 `blocksExternalGesture` **7회**를 확인했고
`bfee682e^`=0 / `bfee682e`=4로 **이 커밋 전용 심볼**임까지 확인했다 — stale 아님. 배선은 살아 있었고 효과가 없었다.

### 판정자가 내 기하 이해를 바로잡았다 — 이게 이 라운드의 두 번째 수확

내가 §NN·§OO에서 "**마지막 도색 행 아래 공백**"이라고 쓴 것을 판정자가 정밀화했다:

`[fit]renderer`가 `cols:80, contentW:640, scale:0.628125, vpWidth:402` → 서피스 폭 = 640×0.628 =
**402pt = 뷰포트 전폭**. XCUITest 스냅샷도 `{{0,130},{402,546}}`.
**즉 가로 공백은 존재하지 않는다. 경계는 세로뿐이다.**

그리고 **7차의 "y≥500 공백"은 상수가 아니었다** — 그 픽스처의 서피스가 짧았을 뿐이고,
이번 픽스처에선 공백대가 **y≥680**이다. 판정자가 y를 쓸어 확인했다(560/620/660=글자, 680/700=공백).
**같은 좌표계에서 7차 표가 재현된 것이 하네스 유효성의 증거다.**

### 되돌렸다 — §OO에서 안 지킨 규율을 여기서는 지킨다

`blocksExternalGesture(Gesture.Native())`를 `git revert`했다. §OO의 passive 변경을 유지한 판단과
**다르게 판단한 이유**를 남긴다:

| | passive/`touch-action` (§LL~§NN) | `Gesture.Native()` 중재 (§QQ) |
|---|---|---|
| 독립적 값 | **있다** — 표준 형태이고 `-webkit-touch-callout`으로 콜아웃 억제까지 얻었다 | **없다.** 오직 이 결함만 겨냥했다 |
| 측정된 이득 | iOS 회귀 4종 PASS + **Android 회귀 없음**(§PP) | **0** |
| 남는 위험 | 측정으로 해소됨(§PP) | Android가 **이 변경 없이** PASS 받았다(§PP). 중재를 바꾸면 그 리시트가 다시 미검증이 된다 |

**이득 0 + 미검증 위험 + 4줄 되돌림.** 여기서 유지할 이유가 없다.
네이티브 수리는 Swift에서 recognizer 관계를 직접 세우므로, 필요하면 그때 다시 만든다.
게이트 107파일/**918테스트**(§QQ의 배선 테스트가 함께 빠져 919→918), typecheck·lint·format 0.

### 수용 기준 하나가 구조적으로 측정 불가다 — 5번째 "공허한 통과"

**수직축 보존**: 브리프가 요구한 형태("수평이 되는 그 좌표에서 수직이 안 되는가")는 **원리적으로 불가**다.
수평이 되는 유일한 곳(y≥680)은 **터미널 문서가 아예 없는 곳**이라 `touchProbe`가 울릴 수 없다.

다만 판정자가 **글자 위 수직은 정상임을 따로 실증**했다: `finalize success=false dy=−14`
(`failOffsetY=12`에서 실패) + `touchProbe moves=19`로 터미널 수신. **터미널은 자기 축을 갖고 있다.**
남은 미지는 "수평이 살아난 뒤에도 그런가"뿐이고, 그건 N1이 닫힌 다음에만 물을 수 있다.

### 부수 — 지연은 이번에도 M6a 소유가 아니다

스와이프분(DRAGEND→헤더 커밋) **30·99·123·178·188·221·247ms, 중앙값 ≈178ms** — Android(184ms)와 동급, 예산 내.
문서 재빌드분(`finalize`→`[fit]renderer`) **495·533·760·822ms, 중앙값 ≈646ms** — **N2**.

### N1에 남은 것

RNGH가 제공하는 JS 레버는 **둘 다 소진**됐다(문서 안 `passive`/`touch-action` = §OO,
문서 밖 `blocksExternalGesture` = 여기). 남은 것은 **진짜 네이티브**:
`WKWebView.scrollView.panGestureRecognizer`(및 `UIWebTouchEventsGestureRecognizer`)에 대해
RNGH의 pan을 `require(toFail:)` 시키거나 `shouldRecognizeSimultaneouslyWith`를 여는 Swift 코드.
Expo config plugin 또는 소형 네이티브 모듈이 그릇이다.

## SS. 타이포 계약이 iOS에서 한 번도 성립한 적이 없었다 — 7라운드가 못 본 채로 (2026-08-25, 수리 `fd42c472`)

**결함**: 목업의 단 하나의 비타협 타이포 사실은 JetBrains Mono 전면 적용인데
(`assets/mockup.html:14,863`), 앱에는 폰트 에셋도 로더도 **없었다**. orca에서 온
`typography.monoFamily = 'monospace'`는 **Android generic family명**이라 iOS엔 대응 항목이
없고, RN이 조용히 SF Pro(산세리프)로 떨어진다. **모든 iOS 화면이 산세리프로 렌더되고 있었다.**

**7라운드의 목업 대조 QA가 왜 못 봤나**: Android에선 `'monospace'`가 Roboto Mono로 풀려
*보기에* 맞았고, 스크린샷 기반 판정자는 "모노스페이스인가"를 화면에서 읽지 값 자체를 읽지 않는다.
1차 QA가 "일반 Material 다크로 읽힘"이라 한 것의 절반은 사실 이 결함의 냄새였다(그때는 2개
컴포넌트의 서체 누락으로 좁혀 닫았다). **스크린샷 대조는 '어느 플랫폼에서 찍었나'에 종속인
판별자다** — 이번 것은 값을 직접 검사하는 유닛 테스트(`herdr-typography.test.ts`)로 기계화했다.

**수리 (`fd42c472`)**: expo-font + @expo-google-fonts/jetbrains-mono 정확 핀,
`_layout.tsx`가 splash를 잡고 로드를 기다린다(`fontsError`는 비차단 — 서체 실패는 플랫폼
기본으로 강등이지 백지가 아니다). orca의 `mobile-theme.ts`는 byte-identical 계약이라
`herdr-typography.ts` shim으로 override. Android는 커스텀 패밀리에 weight 합성이 없으므로
bold 콜사이트는 `monoFamilyBold`를 이름으로 갖는다.

**잔여**: 기기 확증 필요 — 양 플랫폼 재QA 라운드에서 ①iOS가 실제로 JetBrains Mono로 렌더
②Android가 Roboto Mono→JetBrains Mono 전환 후에도 클리핑 회귀 없음(1·2차가 잡던 클래스)을 본다.

## TT. 게이트 하네스 오염 2종 — `cargo test` 금지의 근거 (2026-08-25)

`cargo test` 전량 실행이 signal 13(SIGPIPE)으로 죽거나 `manifest_action_invoke_injects_plugin_paths`가
실유저 `~/.config/herdr-dev` 경로를 읽으며 실패한다. 둘 다 **단독 실행은 PASS** — libtest가
한 프로세스에서 스레드로 도는 탓에 ①`begin_cli_output()`(`src/platform/unix_common.rs:15`)이
바꾼 전역 SIGPIPE disposition ②`std::env` 변이가 테스트 경계를 넘는다. 제품 결함 아님.
**전량 판정은 nextest로만** — 같은 트리에서 `cargo nextest run --all-features --retries 2
--no-fail-fast` = **4003/4003 green**(flaky 1건 재시도 통과). `01-spec.md` 함정 목록에 승격.

## UU. `remote.set_keybindings`는 폰의 자기-원격에는 닿지 않는다 — 알고 배선했다 (2026-08-25, `e7a30fba`)

**발견 (폰 절반 구현 에이전트)**: 핸들러는 응답한 서버 **자신의 레지스트리**에서 `remote_id`를
찾는데(`src/app/api/remotes.rs` → `src/remote_registry.rs:244-256`, 없으면 `remote_not_found`),
서버는 자기 자신을 레지스트리에 등재하지 않는다 — 멀티리모트 클라이언트가 자기 박스를
`ServerId::main()`으로 레지스트리 밖에서 합성한다(`src/client/supervisor.rs:911-919`). 폰의
settings 폼이 편집하는 대상(키스토어 원격 = 폰이 ssh로 붙는 그 박스)에 이 호출은
`remote_not_found`일 수 있다. 실제로 값이 바뀌는 대상은 허브 레지스트리의 **listed 원격**뿐.

**배선 방식**: 성공을 가정하지 않는다 — 서버 답 4상태(미연결/거부/다른 값 에코/적용)를
`keybindings-push.ts`가 판정해 화면에 그대로 적고, **로컬 키스토어 저장은 어느 경우에도
살아남는다**(그 값은 `app-connections.ts`의 `RemoteDefinition`으로 폰 자신의 접속에 운반된다).
"무동작 컨트롤 금지"는 이렇게 지켜진다.

**확장 안 함 (디스패처 판정)**: nodes 행(listed 원격)으로 컨트롤을 옮기거나 복제하지 않는다 —
목업 #7이 지정한 자리는 settings 폼뿐이고(조건 4), 목업에 없는 표면 신설은 초과다. 허브
listed 원격의 keybindings 편집이 실제로 필요해지는 순간 이 절이 그 근거 문서다.

## VV. Android UI QA 8차 — 서체 1 FAIL / 4 PASS (2026-08-25, 별도 에이전트, `qa-and-8` @ `7cb4fe8f`)

APK 14:11:39(커밋 13:58 이후, 대조 통과) · Metro 8241 결속을 번들 로그로 확증 · `pm clear` 후 mock 판정
(`└ mock-fixture · …` 3행 + `demo data` 배지 + `remotes · 0`).

- **1 JetBrains Mono — FAIL.** 로드는 성공(글리프 대조: `0` 중앙 점, `l` 플래그+직각 꼬리 — 실TTF
  참조 스트립과 대조)이나 **볼드 5곳이 Roboto(산세리프)로 폴백**: `AgentRow.tsx:104-113`(스타일
  배열 **합성** 페어 — 같은-객체 스윕이 못 잡는 형태), `app/index.tsx:178-186`, `BottomNav.tsx:65`,
  `app/h/[remoteId]/index.tsx:235`, `RemoteEditor.tsx:262`(세그 선택 라벨). 'monospace' 시절에는
  시스템이 볼드를 해소해줬으므로 **Android 실화면 회귀**다. 의심(미확정): `settings.tsx:439,483`,
  `fontWeight:'600'` 사이트들(`WorkspaceListRow.tsx:178,232` 등).
- **2 클리핑 — PASS** (전 화면 스윕, 우측 잘림 0 — 말줄임·개행·가로 스크롤 연속 표시는 비결함).
- **3 요약줄 recent 소비 — PASS** (`└ mock-fixture · test result: ok. 118 passed…` 등 3행 실측 =
  구 `terminal_title_stripped` 근사가 아니라 픽스처 recent 마지막 비빈 줄).
- **4 keybindings 세그 — PASS** (라벨·`local`→`server` 순서·선택 반전 = 목업 `.seg .on` 계약 일치,
  미연결 토글 시 `keybindings · stored as server — … not connected, so nothing was sent` 결과줄이
  `remotes · 1` 아래 렌더 — `keybindings-push.ts` 미연결 경로 문자열 일치).
- **5 회귀 스윕 — PASS** (전이·스와이프·입력바·logcat 치명 0. 특이: dev-client 기어 FAB가
  appbar settings 탭을 가로챔 — dev 오버레이 전용, Tools 스위치로 해소).

**교훈**: "fontWeight 페어 전부 교체" 주장은 같은-객체 페어만 봤다 — **스타일 배열 합성 페어**가
빠졌다. 수리 유닛은 fontWeight 전수 스윕 + weight별 실물 페이스(600 SemiBold 포함) +
**소스 스캔 discipline 테스트**(monotone-discipline 선례)로 기계화한다.

**수리 착지 (`d2c696b7`)**: fontWeight 34곳 전수 처분('700'×15→Bold, '600'×13→SemiBold,
'500'×6→Medium — 강등 0), 페이스 4종 로드, allowlist 5(웹뷰 xterm 문서 — 진짜 브라우저라 CSS
합성 정상). `typography-discipline.test.ts` 신설: RED(34곳)→GREEN + 단일 사이트 복원 시 그
파일:라인으로 재실패 증명 + allowlist 유통기한·페이스 실로드 검사 동반. 1042 tests green.
**추가 발견 겸 수리**: `ConnectionStatusLine`은 family 자체가 없어 라이브 pane 헤더에서
산세리프였다(fd42c472도 8차 QA도 놓친 별개 사이트) — 9차 줌 확인 대상. 미착수 잔존:
포팅 orca 모달 5종의 monotone 팔레트 위반(`statusRed`/`'#fff'` — 아직 어느 화면도 마운트 안 함).

## WW. iOS UI QA 12차 — 5항목 전부 PASS (2026-08-25, 별도 에이전트, `qa-ios-12` @ `7cb4fe8f`)

빌드 14:19:20 · `scripts/pods-install.sh` 경유(`[repair-pods-spm] restored: 4객체`) · **Metro 8251
결속 §HH 이중 확증**(딥링크 + dev 메뉴 `Connected to: …:8251`, 8081 리스너 부재 실측).

- **1 JBMono 실렌더 — PASS. iOS 최초 실증.** dotted zero + `1` 베이스 세리프 zoom 확증, 스윕 전
  화면 산세리프 잔존 0. **주목: fontWeight 700 콜사이트도 iOS에선 폴백 미발생**(모노 렌더) —
  8차 Android FAIL(§VV)은 Android 전용 증상이었다. U6의 페이스 명명 통일은 양 플랫폼 안전.
- **2 요약줄 — PASS** mock `└ mock-fixture · …` 3/3 + **라이브 3경로 실측**(recent 끝줄 /
  빈 recent→title 폴백 / identity==title→생략).
- **3 keybindings — PASS** 반전·순서·영속 + **거부 경로 라이브 실측**
  (`keybindings · qa12lab refused local: the transport is closed`, 로컬 저장 생존).
- **4 splash 게이트 — PASS** (0.7/2.5s splash → ~5.7s 완전 진입, 산세리프 프레임 0).
- **5 회귀 — PASS** (스와이프 6/6, 딥링크 3종, 입력 문자 왕복 실증, 크래시 0).
- live 판별 = 위조 불가 토큰 `ZQ12-LIVE-22b6b1fb` + sshd `Accepted publickey … ED25519`(일회용 키).

**잔여 관찰 (비-FAIL, 다음 유닛)**: **터미널 웹뷰 내부 서체가 JBMono가 아니다**(무점 0 —
웹뷰 자체 폰트 스택). RN 층 수리(fd42c472·d2c696b7)의 범위 밖이고, 목업 "전면 JBMono"
계약(:14,863)의 마지막 구멍. 웹뷰 문서에 페이스 임베드가 수리 방향 — 셀 메트릭이 바뀌므로
§P(213col 도달 불가)와 fit/scale 계열의 재측정이 따라와야 한다.

## XX. 웹뷰 터미널 JBMono 임베드 — 전면 JBMono 계약의 마지막 구멍 수리 (2026-08-25, `16248702`)

Regular+Bold 2페이스 base64 임베드(+308 KiB/플랫폼, 코드젠 산출물 gitignore), 폰트 스택 선두
`"JetBrains Mono"`, **`web-ready`를 `document.fonts` 로드 뒤로 게이트**(로드 전 측정 = 폴백
메트릭으로 셀이 굳는다; 3s 상한, RED 증명 2종). **함정 회피 기록**: xterm `fontWeightBold:'500'`
이 400/700 정수 선언에선 CSS 매칭상 400으로 떨어져 볼드가 붕괴 — `font-weight: 100 400`/`500 900`
**구간 선언**으로 강제. JBMono advance = 정확 0.600em(Regular=Bold — 볼드가 그리드를 안 민다).

**§P는 이 커밋이 안 고쳤다** — fit/scale 로컬 테스트는 전부 셀 치수를 주입하므로 실폰트 메트릭을
잴 능력이 없다. 다음 기기 라운드에서 `[fit]renderer` cellW 실측 필요(단 §BB대로 그 `cols`는
그리드 근거 아님). 잔여: italic은 합성 oblique(폭 안전, +300KiB면 실페이스 가능),
`document.fonts` 부재 엔진은 no-op(실측 대상 기기엔 전부 존재), oxlint max-lines 캡(1784)이
정확값 지뢰, 생성 모듈은 postinstall 미실행 체크아웃에서 import 파손(기존 엔진 산출물과 동일 전제).

## YY. Android UI QA 9차 (표적) — **5/5 전 항목 PASS** (2026-08-25, 별도 에이전트, `qa-and-9` @ `16248702`)

APK 15:15:27 > 커밋 대조 통과 · Metro 8242 단독 리슨 + 딥링크 직결(10.0.2.2, adb reverse 불사용) ·
postinstall 생성물 2종(엔진 624KB + 폰트 306KB) 확인 후 시작.

- **8차 FAIL 5곳 전부 PASS** — 실TTF 참조 스트립(4 weight + Helvetica Bold 대조군) 글리프 대조로
  AgentRow명·섹션 라벨·하단 nav 선택 라벨·탭 섹션 헤더·keybindings 세그 선택 라벨(양 상태) 전부
  JBMono Bold. 볼드 폴백 클래스 소멸.
- **500/600 표본 PASS** (repo/branch 행 + History 버튼 SemiBold 실렌더).
- **웹뷰 내부 서체 PASS** — 라이브 pane에서 `0` 전부 dotted, `O` 무점 대조 명확. fit 정상(80col
  그리드 정렬). **§P 관찰**: `[fit]renderer { renderer:'webgl', cellW: 7.6190…, paintedCellW: 0 }`.
- **ConnectionStatusLine 라이브 PASS** — mock에선 설계상 null 렌더(supervisor 부재,
  `ConnectionStatusLine.tsx:42-44`) → 랩 연결 후 sshd PID kill로 `● Can't connect · Retry` 격상,
  라벨·버튼 JBMono.
- **회귀 PASS** — 요약줄 유지(그 `0`도 dotted), 스와이프, 입력 왕복(`echo QA9INPUT0K` 실행+출력),
  클리핑 신규 0, logcat 치명 0. live 판별 = 일회용 키 `Accepted publickey … ED25519` + 토큰
  `ZQ9-LIVE-66b8e50f` 실렌더 + `demo data` 배지 소멸.

## ZZ. iOS UI QA 13차 (표적) — **5/5 전 항목 PASS** (2026-08-25, 별도 에이전트, `qa-ios-13` @ `16248702`)

빌드 15:23:07(BUILD SUCCEEDED, pods-install.sh 경유) · **§HH 결속**: 앱 PID의 ESTABLISHED TCP 전부
`127.0.0.1:8252`(단독 리스너), 8081/8251 부재 — 타 트리 JS 혼입 불가능.

- **1 웹뷰 내부 서체 PASS (머리기사)** — 글리프 라인 심고 4배 줌: `0O0O`에서 0 전부 중앙 점·O 무점,
  `1lI` 세리프 = JBMono. **칩 전환 + 스와이프 왕복 2회 후에도 유지.** fit 정상.
  §P 관찰: `cellW:7.667, paintedCellW:0, cols:80, scale:0.655` (U7 주석 7.80 예측 대비 실측 7.667).
- **2 U6 무회귀 PASS** — 12차 PASS 표면 + 신규 500/600 표본 전부 JBMono.
- **3 splash 게이트 PASS** — ~1.5s 첫 콘텐츠 프레임부터 모노, 산세리프 프레임 0.
- **4 회귀 PASS + 관찰 1** — 요약줄 3행·스와이프 2/2·크래시 0. **관찰(비차단, 판정 불가로 기재)**:
  XCUITest `typeText` 26자 중 pty에 "ec" 2자만 도달, 2/2 결정적 재현 — 키스트로크→pty→실행→에코
  경로 자체는 생존. 하네스 타이핑 경로 vs RN controlled-input 동기화 미판별 → **다음 라운드 표적**.
  (12차 "입력 왕복"과의 방법 차이 미기록이라 회귀 단정 불가.)
- **5 클리핑 신규 0 PASS.**
- live 판별 = 토큰 `ZQ13-LIVE-acf9be7e` 실렌더 + lsof ESTABLISHED + herdr 로그 `client connected`.
- 리그 함정 기록: **랩 unix socket을 긴 scratchpad 경로에 두면 104바이트 초과로 herdr 서버가
  조용히 못 뜬다** — `/tmp/<lab>` 단경로가 해법.
