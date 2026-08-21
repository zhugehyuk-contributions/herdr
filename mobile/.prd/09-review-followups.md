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

---

**규율**: 이 목록은 *n번째 문서화*가 아니라 **추적 큐**다. 항목을 닫을 때는 여기서 지우고 커밋 메시지에 근거를 남긴다.
