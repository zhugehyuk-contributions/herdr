# 08 — orca mobile 파일 단위 이식 지도

[`01-spec.md`](./01-spec.md) 전제 2("orca의 와꾸를 최대한 그대로")를 **구현자가 쓸 수 있는 단위**로 내린 문서.
[`02-architecture.md`](./02-architecture.md) §2.5의 카테고리 표가 상위 계약이고, 이 문서는 그 표를 **파일 경로**로 해상한다.
[`05-orca-transport.md`](./05-orca-transport.md)의 L1~L7 · X1~X6 · P1은 §3에서 orca의 `file:line`으로 고정된다.

**조사 기준**: orca `1ce2e562` (`stablyai/orca`, `--depth 1`, 2026-08-22 클론).
증거 표기 — 표시 없음 = 직접 열어 확인 · `[미확인]` = 열지 않음.
orca 경로는 별도 표기가 없으면 `mobile/` 기준, herdr 경로는 herdr 레포 루트 기준.
**orca는 이 레포에 벤더링하지 않는다** — 이식은 파일 단위 복사 + 출처 헤더다(§0).

---

## 0. 라이선스 판정 — 가져와도 된다

**MIT.** `LICENSE` (레포 루트, 21줄): `Copyright (c) 2026 Lovecast Inc.`
표준 MIT 본문 — *"to deal in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense"*.

| 항목 | 판정 |
|---|---|
| 코드 복사 | **가능.** 수정·재배포·서브라이선스까지 허용 |
| 조건 | **저작권 고지 + 허가 고지를 "copies or substantial portions"에 포함**해야 한다 |
| copyleft | **없다.** herdr 쪽 라이선스를 MIT로 바꿀 필요 없음 |
| 특허·상표 | 조항 없음. 단 `Orca` 이름·아이콘·`com.stably.orca.mobile` 번들 ID·`orca://` 스킴은 코드가 아니라 **브랜드**다 — 전부 herdr 것으로 교체 |

**실행 규칙**: `mobile/THIRD_PARTY_NOTICES.md`(신설)에 orca LICENSE 전문 + 커밋 `1ce2e562`를 적고,
orca에서 유래한 파일마다 상단에 3줄 헤더(출처 경로 · 커밋 · MIT / Lovecast Inc.)를 남긴다.
→ **전제 2는 라이선스 때문에 바뀌지 않는다.** 이 판정이 뒤집혔다면 전제 2 전체를 다시 열어야 했다.

---

## 1. orca `mobile/`의 실물

**규모**: `mobile/` 아래 파일 1,262개(node_modules 제외). `src/` 1,157파일 / **161,419줄**, `app/` 29파일 / 28,471줄.
테스트 파일 458개 대 비테스트 소스 699개 — **테스트:소스 ≈ 0.65**. 이 비율이 §2에서 `port` 등급이 성립하는 근거다.

| `src/` 하위 | 파일 | 그중 테스트 | 줄 |
|---|---|---|---|
| `transport/` | 190 | 80 | 27,364 |
| `session/` | 310 | 134 | 48,310 |
| `terminal/` | 107 | 50 | 14,811 |
| `components/` | 174 | 44 | 25,090 |
| `source-control/` | 84 | 25 | 10,806 |
| `tasks/` | 74 | 32 | 7,833 |
| `worktree/` | 51 | 22 | 5,031 |
| `files/` | 40 | 15 | 4,988 |
| `notifications/` | 15 | 8 | 3,328 |
| `hooks/` · `navigation/` · `storage/` · `diagnostics/` · `layout/` · `theme/` | 34 | 13 | 4,482 |

### 스택 (전부 `package.json` · `app.json` · `tsconfig.json` · `vitest.config.ts` 직접 읽음)

| 축 | 실물 |
|---|---|
| Expo | `expo ^55.0.27`, `newArchEnabled: true` (`app.json`) |
| **bare인가** | **아니다 — CNG(prebuild)다.** `/ios/`·`/android/`가 `.gitignore:7-8`에 있고 네이티브는 `expo run:*`가 생성. 네이티브 확장은 **config plugin**으로 한다 (`plugins/android-respect-rotation-lock.js` 1개가 실사용례, `app.json` plugins 배열) |
| expo-router | `^55.0.14`, 엔트리 `"main": "expo-router/entry"` |
| RN / React | `react-native ^0.83.9` (**패치됨** — `patches/react-native@0.83.9.patch`, pnpm `patchedDependencies`) / `react ^19.2.6` |
| **상태관리** | **React Context + ref.** `zustand ^5.0.13`이 의존성에 있으나 **`src/`·`app/` 어디서도 import되지 않는다(0파일)** — 실제 스토어는 `src/transport/client-context.tsx`(453줄)의 provider + `storeRef`/`acquisitionsRef` 패턴이다 |
| 테스트 | **vitest `^4.1.9`** (`environment: 'node'`), `react-test-renderer 19.2.6`, `happy-dom`. `vitest.config.ts:16-19`가 `.tsx`까지 수집(과거 컴포넌트 테스트가 조용히 미수집이었다는 주석) |
| lint/format | **oxlint `^1.71.0` / oxfmt `^0.52.0`** (eslint/prettier 아님) |
| TypeScript | **6.0.3**, `strict: true`, `paths: {"@/*": ["./src/*"]}`, `include`에서 테스트 제외 |
| 패키지 | pnpm 워크스페이스(`pnpm-workspace.yaml`), 로컬 패키지 `packages/expo-two-way-audio` 1개 |
| 터미널 엔진 | `@xterm/xterm 6.1.0-beta.285` + `addon-webgl` + `addon-unicode11`. `postinstall`이 `scripts/build-terminal-webview-engine.mjs`로 **`src/terminal/terminal-webview-engine.generated.ts`를 빌드 산출물로 생성**(gitignore됨) → WebView HTML에 인라인 |
| 검증 | zod `~4.4.3` (8파일). E2EE는 `tweetnacl` + `@noble/hashes` |
| Metro | `metro.config.js:9,14-15` — `watchFolders`에 **레포 루트 `src/shared`**를 추가 |

> **§6 위험 1과 직결**: 위 마지막 줄이 이식 비용의 숨은 절반이다. `mobile/` 파일 **293개**가
> `../../../src/shared/*`(orca 데스크톱 TS 공유 코드)를 import한다.

---

## 2. 파일 단위 이식표

등급 = **copy**(거의 그대로) · **port**(로직·테스트 유지, I/O 교체) · **rewrite**(근본이 다름) · **drop**(대응 없음).
herdr 대응 경로의 `packages/herdr-client-ts/`는 **이미 존재**한다(M1 착수분, 커밋 `86b702d4`).

### 2.1 스캐폴딩 — copy

| orca 경로 | 줄 | 등급 | herdr 대응 | 근거 |
|---|---|---|---|---|
| `package.json` | 96 | copy | `mobile/package.json` | 의존성 목록이 곧 검증된 버전 조합. **zustand는 빼라**(0파일 사용) |
| `tsconfig.json` | 20 | copy | `mobile/tsconfig.json` | `@/*` 경로 별칭 + 테스트 제외까지 그대로 |
| `vitest.config.ts` / `vitest.setup.ts` | 24/2 | copy | 동일 | `.tsx` 수집 주석(`:16-19`)이 실패에서 배운 설정 |
| `metro.config.js` | 15 | **port** | 동일 | `watchFolders` 대상만 `src/shared` → `packages/herdr-client-ts` |
| `.oxlintrc.json` | 4042B | copy | 동일 | oxlint 룰셋 |
| `app.json` | 149 | port | 동일 | 구조 복사, 브랜드·번들ID·스킴·권한문구 전부 교체. **카메라/사진/마이크 권한은 삭제**(페어링 QR·음성이 drop이므로) |
| `plugins/android-respect-rotation-lock.js` | — | copy | 동일 | `app/_layout.tsx:171-175`가 이 플러그인 없이는 회전잠금이 깨진다고 명시 |
| `scripts/build-terminal-webview-engine.mjs` | 108 | copy | 동일 | xterm→단일 HTML 번들 파이프라인 |
| `scripts/start-expo.mjs` · `start-emulator.mjs` | 49/686 | copy | 동일 | 개발 편의. emulator 스크립트는 페어링 런타임 의존부만 절단 |
| `Gemfile`/`fastlane/` · `Casks` | — | drop | — | 배포 채널이 다르다 |

### 2.2 라우트 셸 — copy / drop

| orca 경로 | 줄 | 등급 | herdr 대응 | 근거 |
|---|---|---|---|---|
| `app/_layout.tsx` | 213 | **copy** | `mobile/app/_layout.tsx` | Provider + Stack + 스플래시 타이밍(`:152-158`) + 알림 탭 라우팅(`:73-150`). 딥링크 `orca://pair` 분기(`:52-71`)만 삭제 |
| `app/h/_layout.tsx` | 189 | **copy** | 동일 | **master-detail의 실체.** 태블릿 분할 + 드래그 리사이즈 + `MIN_DETAIL_WIDTH`(`:17`) + 폰/태블릿 애니메이션 분기(`:36-39`). 스크린 목록만 herdr 것으로 |
| `app/index.tsx` | 1362 | port | `app/index.tsx` (리모트 목록) | 호스트 카탈로그 목록 → herdr remote 목록. 페어링 진입점·QR 제거 |
| `app/h/[hostId]/index.tsx` | 1719 | port | `app/h/[hostId]/index.tsx` (워크스페이스 목록) | worktree 목록 + 에이전트 롤업 = herdr 워크스페이스 목록의 동형물 |
| `app/h/[hostId]/session/[worktreeId].tsx` | **5333** | **port(분해)** | `app/h/[hostId]/session/[wsId].tsx` | 뷰어 본체. **통째로 복사 금지** — §6 위험 2 |
| `app/connection-log.tsx` | 221 | **copy** | 동일 | 전송 무관 |
| `app/troubleshoot.tsx` | 415 | copy | 동일 | 문구만 ssh 실패 모드로(L6) |
| `app/settings.tsx` · `terminal-settings.tsx` · `about.tsx` | 321/383/167 | **copy** | 동일 | 설정 셸. terminal-settings는 액세서리 키 편집 UI를 낀다 |
| `app/notifications.tsx` · `notification-opt-in.tsx` | 178/12 | copy | 동일 | M5용. 스케줄 소스만 herdr 플러그인 큐로 |
| `app/mobile-onboarding.tsx` | 215 | port | 동일 | 온보딩 골격. 스텝 내용은 ssh 키 등록으로 |
| `app/pair.tsx` · `pair-scan.tsx` · `pair-confirm.tsx` | 87/541/286 | **drop** | — | ssh가 인증이다 |
| `app/h/[hostId]/tasks.tsx` | **15168** | **drop** | — | herdr JSON API에 대응 없음. **단일 파일 15k줄 — 오해 방지를 위해 명시적으로 뺀다** |
| `app/h/[hostId]/{files,source-control,review,pr,history,agent-history}/*` | 167 합 | drop | — | `git.*`/`files.*` 없음 |
| `app/h/[hostId]/accounts.tsx` · `edit.tsx` | 395/375 | drop / port | `edit` → 리모트 편집 | `accounts`는 orca 계정 모델 전용 |
| `app/{voice,native-chat,browser}-settings.tsx` | 411/126/163 | drop | — | 대응 기능 없음 |

### 2.3 transport — port(정책) + rewrite(I/O) + drop(릴레이)

| orca 경로 | 줄 | 등급 | herdr 대응 | 근거 |
|---|---|---|---|---|
| `src/transport/rpc-session-liveness-watchdog.ts` | 196 | **port** | `packages/herdr-client-ts/src/watchdog.ts` | **순수 클래스.** 소켓을 모른다 — `sendProbe`/`terminate` 콜백 주입(`:9-10`). ssh에 그대로 얹힌다 (L1·L1b) |
| ↳ `.test.ts` + `rpc-session-liveness-integration.test.ts` | 145+188 | **port** | 동일 | 주입식이라 테스트도 전송 무관 |
| `src/transport/rpc-stale-dial.ts` | 16 | **copy** | 동일 | 순수 함수 1개(`:14-16`). 상태 이름만 매핑 (L5) |
| `src/transport/connection-health.ts` | 126 | **port** | 동일 | 에스컬레이션 사다리(`:22-24`). 라벨/힌트만 ssh 문구로 (L6) |
| `src/transport/connection-revival-triggers.ts` | 52 | **copy** | 동일 | `AppState` + `expo-network`. **전송을 전혀 모른다** (L4) |
| `src/transport/request-single-flight.ts` | 110 | **port** | 동일 | `WeakMap<RpcClient, …>` 키 타입만 교체 (X5). **B8이 사는 동안 필수** |
| `src/transport/rpc-delivery-ambiguity.ts` | 15 | **copy** | 동일 | `WeakSet<Error>` 태깅 (X2) |
| `src/transport/protocol-compat.ts` · `protocol-version.ts` | 42/20 | **port** | 동일 | 판정 로직 copy, 상수는 herdr `PROTOCOL_VERSION=20` 체계로 (X6 = B1) |
| `src/transport/rpc-socket-close-evidence.ts` | 70 | **port** | 동일 | `RpcSynthesizedCloseIndex`(`:15-34`)는 구조 유지, `logRpcSocketClose`는 close code → exit status/stderr (L2) |
| `src/transport/connection-log-buffer.ts` | 84 | **copy** | 동일 | 링버퍼 |
| `src/transport/client-context.tsx` | 453 | **port** | `mobile/src/transport/client-context.tsx` | **호스트당 공유 클라이언트 1개**의 실체. acquire/release 리스카운팅 + `forceReconnect`(`:238-260`) + `useHostClient` 재조회(`:385-399`, X4) |
| ↳ `client-context.test.ts` · `settings-host-client-lifecycle.test.ts` | 638+724 | port | 동일 | 수명주기 계약 |
| `src/transport/rpc-client.ts` | **1224** | **rewrite(정책 이식)** | `packages/herdr-client-ts/src/session.ts` (신규) | **WebSocket + E2EE + orca RPC가 뼈에 박혀 있다.** 그러나 §3의 L2·L3·L5·X1·X2가 여기 산다 → **정책 함수를 뽑아 port, 소켓 계층은 rewrite** |
| ↳ `rpc-client.test.ts` (`foreground recovery` describe) | 1005 | **port** | 동일 | fake-timer로 parked loop 재현. 시나리오는 전송 무관 |
| ↳ `rpc-client-live-recovery.test.ts` | 207 | port | 동일 | opt-in 라이브 하네스 패턴 — herdr은 실서버 격리 하네스가 이미 있다 |
| `src/transport/rpc-client-terminal-subscription.ts` | 86 | **port** | 동일 | `updateTerminalSubscriptionViewport`(`:12-34`)가 X1b의 실체 |
| `src/transport/rpc-client-terminal-binary-frame.ts` | 107 | **rewrite** | `herdr-client-ts/src/messages.ts` (존재) | 와이어 코덱 — herdr은 bincode |
| `src/transport/host-store.ts` (+`host-endpoint.ts`) | 343+365 | **port** | `mobile/src/transport/host-store.ts` | 호스트 카탈로그 영속화. 필드가 endpoint/token → ssh user@host:port + 키 별칭 |
| `src/transport/host-open-retry-scheduler.ts` · `host-status-gates.ts` · `host-list-load-sharing.ts` | 79/115/38 | port | 동일 | 열기 재시도·게이트·목록 공유 |
| `src/transport/socket-event-debug.ts` · `websocket-payload-bytes.ts` | 42/27 | rewrite | — | WebSocket 이벤트 직렬화 |
| `src/transport/{mobile-relay-*,relay-*,pairing*,pre-profile-pairing*}` (61파일) | **9,046** | **drop** | — | 릴레이·페어링 — ssh가 대체 |
| `src/transport/{e2ee.ts,mobile-e2ee-*}` (8파일) | 882 | **drop** | — | ssh 인증이 대체 |
| `src/transport/mobile-endpoint-*` (11파일) | 2,126 | **drop(단 L4는 §3에서 별도)** | — | direct↔relay 경로 감독 — herdr엔 경로가 1개 |
| `src/transport/runtime-capability-probe.ts` | 67 | port | 동일 | 서버 기능 탐지 → herdr `Ping`/`RequestFullFrame` 존재 여부(B1) |

### 2.4 terminal — copy가 가장 크게 남는 층

| orca 경로 | 줄 | 등급 | herdr 대응 | 근거 |
|---|---|---|---|---|
| `src/terminal/terminal-webview-html.ts` | **1885** | **copy** | `mobile/src/terminal/terminal-webview-html.ts` | **최대 단일 이득.** xterm 초기화 + `scrollback: 5000`(`:736`) + 선택/탭/휠/줌/WebGL 복구 전부. **herdr 읽기 경로가 ANSI 바이트라 여기가 그대로 소비자다** |
| `src/terminal/TerminalWebView.tsx` | 396 | **copy** | 동일 | RN↔WebView 브리지. 유일한 외부 의존이 `import type` 1줄(`:4`) |
| `src/terminal/terminal-webview-pending-messages.ts` | 55 | **copy** | 동일 | `web-ready` 전 메시지 큐 + 바이트 상한(`:3-4`). `terminal-output-streaming-findings.md`가 값을 치르고 얻은 것 |
| `src/terminal/terminal-webview-ready-watchdog.ts` | 48 | **copy** | 동일 | X3. 백그라운드면 판정 보류·재무장(`:29-32`) |
| `src/terminal/terminal-webview-contract.ts` · `-messages.ts` | 103/28 | copy | 동일 | 브리지 메시지 타입. `import type` 2줄만 절단 |
| `src/terminal/terminal-write-coalescer.ts` | 73 | **copy** | 동일 | 쓰기 합치기 — B13(무압축 ANSI) 때문에 herdr에서 **더** 중요 |
| `src/terminal/terminal-accessory-keys.ts` | 411 | **port** | 동일 | M3의 액세서리 키 행. **바이트 테이블은 그대로**(`:28-70` ESC/시프트/Ctrl 매핑), 출력만 `pane.send_input{keys[]}`로 |
| `src/terminal/terminal-accessory-layout.ts` | 230 | copy | 동일 | 키 행 순서·표시 영속화 |
| `src/terminal/terminal-input-connection-gate.ts` | 26 | **copy** | 동일 | X2 후반부 — **끊긴 상태에서 compose는 허용, send는 차단**(`:20-25`). herdr의 "절대 큐잉하지 않는다"와 정확히 같은 규칙 |
| `src/terminal/terminal-keyboard-avoidance-*.ts` · `-dismiss` · `-type` | ~130 | copy | 동일 | iOS/Android 키보드 리프트 차이(`session:4205-4211`) |
| `src/terminal/terminal-webview-{tap,url-tap,wheel-scroll,mouse-*}-injected.ts` | ~590 | copy | 동일 | WebView 주입 스크립트. 마우스 리포팅은 M6까지 비활성 |
| `src/terminal/terminal-viewport-refit.ts` (+state) | 315+104 | **port** | 동일 | xterm 자체 fit — 유지. **서버 리사이즈와 구분할 것** |
| `src/terminal/terminal-foreground-recovery.ts` | 79 | copy | 동일 | 복귀 시 WebView 복구 |
| `src/terminal/quick-commands.ts` | 108 | **copy** | 동일 | M3의 y/n/승인 퀵커맨드 |
| `src/terminal/mobile-terminal-query-reply.ts` | 51 | port | 동일 | DA/DSR 응답 — herdr은 `pane.send_input`으로 되돌린다 |

### 2.5 세션·컴포넌트·나머지

| orca 경로 | 줄 | 등급 | herdr 대응 | 근거 |
|---|---|---|---|---|
| `src/session/TerminalPaneView.tsx` | 105 | **copy** | `mobile/src/session/PaneView.tsx` | 순수 프레젠테이션 래퍼 — 콜백 18개, 전송 무지 |
| `src/session/mobile-session-route-types.ts` | (union `:14-55`) | **port** | `mobile/src/session/pane-tree-types.ts` | **§5·§6의 핵심.** 여기가 herdr 4단 트리를 접는 자리 |
| `src/session/active-session-tab.ts` | (`:19-60`) | **port** | 동일 | 활성 선택 결정 규칙 — snapshot vs 사용자 의도 우선순위 |
| `src/session/tab-strip-scroll.ts` · `mobile-tab-close-selection.ts` | 소 | copy | 동일 | 칩 스트립 스크롤/닫기 후 선택 |
| `src/session/mobile-terminal-records.ts` | (`:4-25`) | port | 동일 | pane 레코드 형태 |
| `src/session/mobile-terminal-stream-subscribe.ts` | 17 | **copy** | 동일 | 동기 throw까지 흡수하는 구독 래퍼(`:9-16`) |
| `src/session/mobile-terminal-diagnostics.ts` | (진단 이벤트) | port | 동일 | 연결로그 화면의 공급자 |
| `src/session/mobile-terminal-viewport-resubscribe.ts` | **293** | **drop** | — | **§6 위험 3 — 계획에 없던 발견.** 이 전체가 *데스크톱 PTY를 폰 뷰포트에 맞추는* fit 루프다. herdr은 observe라 리사이즈하지 않는다(§2.3) → 통째로 불필요 |
| ↳ `.test.ts` | 333 | drop | — | 동일 |
| `src/session/{MobileNativeChat*,github-pr-*,mobile-diff-*,ai-vault-*,QuickCommandEditor*}` | 대부분 | drop | — | 기능 대응 없음 |
| `src/components/{AgentStateDot,AgentSpinner,StatusDot}.tsx` | 65/83/43 | **copy** | `mobile/src/components/` | herdr 상태 어휘와 거의 1:1 — `working`(스피너) / `done` / `blocked·waiting·interrupted`(적색) / `idle`(`AgentStateDot.tsx:10-16`) |
| `src/components/{WorktreeAgentList,WorktreeAgentRow,WorktreeAgentSummary}.tsx` | 55/63/104 | **port** | 동일 | **Agents 홈의 뼈대.** lineage 트리 평탄화 + 접기(`WorktreeAgentList.tsx:17-48`) |
| `src/components/WorktreeListRow.tsx` | 330 | port | 동일 | 워크스페이스 행 + 롤업 |
| `src/components/MobileHostCard.tsx` | 183 | port | 동일 | 리모트 카드. L7의 "tap to retry"(`:52`) |
| `src/components/ProtocolBlockScreen.tsx` | 118 | **port** | 동일 | X6 하드 블록 화면(`:13-30`). 링크만 herdr 릴리즈로 |
| `src/components/HostProtocolGate.tsx` | 121 | port `[미확인]` | 동일 | `app/h/_layout.tsx:13`이 게이트로 씀 — 내용 미확인 |
| `src/components/ConnectionLog.tsx` | 140 | **copy** | 동일 | |
| `src/components/{ActionSheetModal,BottomDrawer,ConfirmModal,PickerModal,PickerListDrawer,RightDrawer,TextInputModal,mounted-bottom-drawer,DragReorderList}.tsx` | ~1,700 | **copy** | 동일 | 범용 UI 프리미티브. **가장 값싼 이득** |
| `src/components/{CustomKeyModal,TerminalShortcutSettings}.tsx` | 685/428 | copy | 동일 | 액세서리 키 편집 — M3 |
| `src/components/{NewWorktreeModal,SmartWorkspace*,Task*,MobileDiffReview*,VoiceModelList,AccountUsage,CodexReset*}` | ~4,500 | drop | — | 대응 없음 |
| `src/theme/mobile-theme.ts` (+contrast test) | 73+38 | **copy** | 동일 | 색 토큰. 대비 테스트가 딸려 있다 |
| `src/layout/responsive-layout*.ts` | 95 | **copy** | 동일 | 폰/태블릿 분기 |
| `src/navigation/host-stack-navigation.ts` (+hook) | 206+45 | **port** | 동일 | 단일 pending 전환 조정(`use-open-host-stack-route.ts:10-12`) — 알림 탭과 사용자 탭 경합 해결 |
| `src/storage/preferences.ts` · `session-view-preferences.ts` | 233/156 | port | 동일 | AsyncStorage 스키마 |
| `src/diagnostics/*` | 373 | port | 동일 | 트러블슈팅 화면 공급자. `host-reachability.ts`는 ssh 다이얼로 rewrite |
| `src/hooks/use-now.ts` | 52 | copy | 동일 | 상대시각 틱 |
| `src/notifications/*` | 3,328 | port(M5) | 동일 | 라우팅(`notification-routing`)은 유지, 스케줄 소스는 herdr 플러그인 큐 |
| `src/{browser,files,tasks,source-control,dictation,accounts,agent-history,onboarding,stats,cache}/` | **31,100** | **drop** | — | v1 대응 없음 |
| `scripts/mock-server*.ts` (12파일) | 1,780 | **port** | `mobile/scripts/mock-server.ts` | P1. 뼈대 유지, 핸들러를 herdr JSON API + 와이어로 |
| `scripts/{test-subscribe,repro-*}.ts\|sh` (6파일) | 1,240 | **port** | 동일 | 폰 없는 재현 |

---

## 3. `05-orca-transport.md` L1~L7 · X1~X6 · P1 → orca `file:line`

**15개 항목 전부 위치 확정. "못 찾음" 0건.** 경로는 `mobile/` 기준.

| # | orca `file:line` | 무엇이 거기 있나 | herdr 이식 노트 |
|---|---|---|---|
| **L1** | `src/transport/rpc-session-liveness-watchdog.ts:1-3` · `:127-145` · `:162-166` | `LIVENESS_IDLE_MS=20_000` / `PROBE_TIMEOUT_MS=8_000` / `MISSED_PROBE_LIMIT=3`; `startProbe`가 `sendProbe` 실패 즉시 terminate(`:140-143`); 3연속 miss에서 terminate(`:163-166`). 호출부 `src/transport/rpc-client.ts:1170-1176` | **순수 클래스, 소켓 무지.** `sendProbe`→herdr `Ping{nonce}`, `terminate`→ssh 채널 강제 종료 |
| **L1b** | `src/transport/rpc-session-liveness-watchdog.ts:152-161` | `elapsedMs > probeTimeoutMs * 1.5`면 **miss로 세지 않고** 재프로브 (`activity-probe unfair window skipped`) | 그대로 copy |
| **L2** | `src/transport/rpc-client.ts:809-817` (`closeAndSynthesize`) · `src/transport/rpc-socket-close-evidence.ts:15-34` · `rpc-client.ts:957-963` | 강제 close 후 `handleSocketClosed(socket,{timedOut:true})`를 **손으로 호출**; `RpcSynthesizedCloseIndex`가 WeakMap으로 세대 추적; `sendEncrypted`가 `state==='connected'`인데 `readyState!==OPEN`이면 desync 판정 | 구조 port. 신호 rewrite: `readyState` → "자식 살아있고 파이프 열렸는데 바이트 없음" |
| **L3** ★ | `src/transport/rpc-client.ts:125-131` · **`:754-780`** | `RECONNECT_DELAYS=[500…60_000]`, `GIVE_UP_AFTER_ATTEMPTS=12`, **`TRICKLE_RECONNECT_DELAY_MS=90_000`**. `scheduleReconnect`가 상한 초과 시 90초 트리클로 계속 재시도하며 **`reconnectAttempt`를 증가시키지 않는다**(`:758-765`) — 주석이 이유를 못박음: 상한에 고정해야 `connection-health`의 "Can't reach desktop" 판정이 유지된다 | **표에서 가장 중요한 한 줄이 실제로 12줄이다.** herdr TS로 그대로 |
| **L4** | `src/transport/connection-revival-triggers.ts:9-52` (배선 `client-context.tsx:299-313`) | `AppState 'active'`(`:12-16`) + `expo-network` 복귀(`:35`) + **타입 변경 = Wi-Fi↔셀룰러**(`:36-38`)를 nudge 하나로. 첫 변화 유실 방지 baseline 시딩(`:19-28`) | **copy.** 전송을 전혀 참조하지 않는다 |
| **L5** | `src/transport/rpc-stale-dial.ts:7` · `:14-16` (호출부 `rpc-client.ts:1178-1198`) | `STALE_DIAL_AGE_MS=2_000`; 2초 넘은 `connecting`/`handshaking` 다이얼은 포기. 호출부가 **`redialNow(!abandoned)`** — 버린 다이얼은 카운터를 **면제하지 않는다**(`:1192-1198` 주석이 issue #10119를 인용) | copy + 상태 이름 매핑. 05표의 "attempt 카운터는 깎지 않는다"가 여기 정확히 구현돼 있다 |
| **L6** | `src/transport/connection-health.ts:22-24` · `:93-116` · `:121-126` | `WARNING_ATTEMPTS=3` / `UNREACHABLE_ATTEMPTS=12`(주석이 `GIVE_UP_AFTER_ATTEMPTS`와 **정렬 필수**라고 명시) / `STALE_SINCE_LAST_CONNECT_MS=60_000`; `verdictDisplayLabel`이 힌트 표기를 단일화 | port. `TAILSCALE_HINT`(`:30`) 자리에 `Permission denied (publickey)` / `herdr: command not found` / 프로토콜 불일치 |
| **L7** | `app/h/[hostId]/session/[worktreeId].tsx:4191-4203` · `:4373-4380` · `src/components/MobileHostCard.tsx:52` | `showConnectionRetry`가 warning/unreachable에서만 참 → 라벨이 `"… — tap to retry"`, 그때만 `disabled=false` + `accessibilityRole='button'` | port. Retry는 **transport 되살리기**(`forceReconnect`)이지 요청 재전송이 아니다 — `client-context.tsx:238-260` |
| **X1** | `src/transport/rpc-client.ts:853-858` (`markStreamsForReplay`) · 호출부 `:464-465` · `:670` · `:731-732` · 재전송 게이트 `:1095-1097` | 모든 스트림의 `sent=false` + 터미널 라우팅 리셋 → 재연결 후 재전송. **구독은 `streamListeners`에 `{method, params}`로 살아있다**(`:1076-1082`) | port. herdr은 `ObserveTerminal` + `RequestFullFrame`(`wire.rs:467`)로 |
| **X1b** | `src/transport/rpc-client-terminal-subscription.ts:12-34` (호출부 `rpc-client.ts:1136-1143`) | `updateTerminalSubscriptionViewport`가 **저장된 구독 params를 제자리에서 갱신**(`:29-32`) → 재연결 시 최신 뷰포트로 replay | port. herdr은 `Hello`의 cols/rows + observe 타깃을 함께 저장 |
| **X2** | `src/transport/rpc-delivery-ambiguity.ts:1-15` · `rpc-client.ts:819-829` · `:1221` · `src/terminal/terminal-input-connection-gate.ts:20-25` | 와이어에 쓰인 뒤 실패한 요청만 `markRpcDeliveryUnknown`; `close()`가 `deliveryUnknown:true`로 pending 전부 거절(`:1221`). 입력 게이트는 **compose 허용 / send 차단** | **copy 2개 + port 1개.** herdr `pane.send_input`은 절대 큐잉 금지 |
| **X3** | `src/terminal/terminal-webview-ready-watchdog.ts:7` · `:22-40` | `WEB_READY_WATCHDOG_MS=15000`; **백그라운드면 판정하지 않고 재무장**(`:29-32`) | **copy.** xterm WebView를 그대로 쓰므로 무수정 |
| **X4** | `src/transport/client-context.tsx:238-260` · **`:385-399`** | `forceReconnect`가 엔트리를 `close()`+`delete` 후 재오픈; `useHostClient`가 **모든 상태변화마다** `getAllClients()`로 재조회하고 다르면 `force(n+1)`(`:390-394`), 엔트리 소멸 시 즉시 null(`:395-399`) | port. #5049의 3번째 근본원인 수정 지점 |
| **X5** | `src/transport/request-single-flight.ts:10-17` · `:56-66` · `:87-106` | `(client, host, kind)` 키 + **trailing follow-up 1개**(최신 params 승). `onSettled` 재귀로 연쇄 | port. **B8(요청 1개=연결 1개)이 사는 동안 ssh 채널 폭발을 막는 유일한 장치** |
| **X6** | `src/transport/protocol-compat.ts:18-42` · `protocol-version.ts:19-20` · `src/components/ProtocolBlockScreen.tsx:13-30` | 양방향 창(`MOBILE_PROTOCOL_VERSION=3` / `MIN_COMPATIBLE_DESKTOP_VERSION=2`) + `blocked{reason}` → 하드 블록 화면. `README.md:145-172`가 "언제 범프하나"를 규정 | port = B1. **README의 범프 규칙이 herdr #70의 빈칸을 그대로 메운다** |
| **P1** | `scripts/mock-server.ts:1-30` + `mock-server-*.ts` 11개(family 12파일 1,780줄) · `scripts/{test-subscribe,repro-terminal-colors,repro-worktree-startup-stream,repro-workspace-picker-lag}.ts` · `repro-mobile-foreground-stall.sh` | 폰 없는 mock 서버 + 시나리오 제어 파일(`README.md:189-195` — **재시작 없이 파일로 모드 전환**, 재시작하면 재키잉되므로) | **M1 헤드리스 코어가 이 역할.** 명문 경계 = `README.md:117` / `terminal-output-streaming-findings.md` "Next Debug Boundary": *폰 없는 재현이 실패하면 WebView/UI를 건드리지 마라* |

> **P1의 진짜 자산은 스크립트가 아니라 규칙이다.** orca는 이 순서 덕에 #5049 인접 버그가
> **서버 쪽**(`src/main/ipc/pty.ts`가 `provider.onData`를 `runtime.onPtyData`로 안 흘림)이었음을 찾아냈다.

---

## 4. herdr에 등가물이 없어 새로 설계할 것

계획(§2.5)은 3개를 든다. **실물 확인 결과 1개는 틀렸고, 2개가 추가된다.**

| # | 항목 | 계획 대비 | 근거 |
|---|---|---|---|
| **N1** | **ssh 네이티브 모듈** (iOS libssh2/NMSSH · Android sshj) — transport 1 + 채널 N | **유지, 최대 신규 작업** | orca 전체에 ssh 코드가 없다. **CNG라서 config plugin으로 싸야 한다**(§1) — bare eject가 아니다. `packages/herdr-client-ts/src/transport.ts:145-149`(`HerdrTransport`)·`:125-134`(`HerdrChannel`)에 인터페이스가 **이미 있다**(단 이 파일은 2026-08-22 현재 **untracked 작업분**) → RN 구현체만 채우면 된다. 주석 `:139-143`이 "openChannel은 단일 ssh 연결 위에 멀티플렉스해야 한다"를 계약으로 못박아 뒀다 |
| **N2** | **와이어 코덱 3종** | **대부분 이미 끝났다** | `packages/herdr-client-ts/src/`(envelope·`Hello`·`Welcome`·`Terminal`·varint·utf8, 커밋 `86b702d4`). 남은 건 `Ping`/`Pong`/`RequestFullFrame`/`ServerShutdown` |
| **N3** | ~~pane(split) 레벨 내비게이션~~ | ❌ **정정 — orca에 선례가 있다** | §5·§6 참조. orca도 desktop에 leaf(pane)가 있고, **모바일이 그것을 평탄화한다** |
| **N4** | **B4 대응 — pane 폭 선언 + 핀치줌/가로스크롤 읽기** | **신규(계획 밖)** | orca는 정반대다: 서버 PTY를 **폰에 맞춰 리사이즈**한다(`mobile-terminal-viewport-resubscribe.ts`). herdr은 그 길이 막혀 있으므로(§2.3) **읽기 UX를 처음부터 설계**해야 한다 |
| **N5** | **관측자 지오메트리 협상** — `Hello`의 cols/rows를 대상 pane 크기로 보내기 | **신규(계획 밖)** | orca에는 "서버를 안 건드리고 내 뷰포트를 서버 렌더에 맞춘다"는 개념 자체가 없다. `pane.get`에 크기 필드가 없어(M1 주석) `stty size` 우회가 필요한 것도 orca에 등가물 없음 |
| **N6** | ssh 오류 모델 | 유지 | `connection-health.ts`의 힌트 슬롯은 있으나 문자열은 전부 신규 |

---

## 5. 착수 순서 — M2를 가장 빨리 화면에 띄우는 경로

**원칙**: 전송이 붙기 전에 먼저 화면이 뜨게 한다. orca는 mock 서버(P1)로 그걸 가능하게 해뒀다.

| 순서 | 가져올 것 | 왜 이 순서인가 |
|---|---|---|
| **0** | `package.json` · `tsconfig.json` · `vitest.config.ts` · `.oxlintrc.json` · `metro.config.js` · `app.json` · `plugins/` | 스택 고정. 여기서 어긋나면 이후 전부 재작업 |
| **1** | `scripts/build-terminal-webview-engine.mjs` + `src/terminal/terminal-webview-html.ts` + `TerminalWebView.tsx` + `terminal-webview-{pending-messages,ready-watchdog,contract,messages}.ts` | **가장 큰 단일 이득(≈2,500줄).** 이게 서면 "ANSI 바이트를 던지면 화면이 나온다"가 성립 |
| **2** | `src/theme/` · `src/layout/` · `src/components/`의 모달·드로어 프리미티브 + `StatusDot`/`AgentStateDot` | 화면을 그릴 어휘. 전부 copy |
| **3** | `app/_layout.tsx` + `app/h/_layout.tsx` | **여기서 앱이 처음 뜬다.** master-detail 골격 확보 |
| **4** | `scripts/mock-server*.ts` → herdr JSON API 응답으로 개조 | **폰·서버 없이** 리스트 화면을 채운다 (P1 경계 확립) |
| **5** | `app/index.tsx`(리모트) → `app/h/[hostId]/index.tsx`(워크스페이스) + `WorktreeAgentList/Row/Summary` | Agents 홈 = 목적의 절반 |
| **6** | `packages/herdr-client-ts` + N1(ssh 네이티브 모듈) 배선 | 실서버 연결. **이 시점 전까지 mock으로 UI가 이미 완성돼 있어야 한다** |
| **7** | `session/[worktreeId].tsx`를 **분해 이식** + `TerminalPaneView.tsx` + pane 칩 전환 | M2 완성 |
| **8** | L1~L7 · X1~X6 (§3) | M4. 정책 파일들은 순수하므로 **언제든 독립 이식 가능** |

> **1→3만으로 "폰에서 herdr 화면이 뜬다"가 성립한다** — orca에서 약 3,000줄, 거의 전부 copy 등급.

---

## 6. 위험 — orca 코드에 박힌, herdr로 못 넘어오는 가정

### 위험 1 (최대) — `mobile/` 파일 293개가 orca **데스크톱** TS 코드를 import한다

`metro.config.js:9,14-15`가 레포 루트 `src/shared`를 `watchFolders`에 넣어, `mobile/`이 데스크톱과 타입·순수함수를 공유한다.

| 디렉터리 | `src/shared` 참조 파일 / 전체 |
|---|---|
| `src/session/` | **115 / 310** |
| `src/components/` | 48 / 174 |
| `src/transport/` | 33 / 190 |
| `src/worktree/` | 17 / 51 |
| `src/terminal/` | **10 / 107** |
| `app/` | 3 / 29 |

**함의**: "copy" 등급 파일도 그냥 복사하면 컴파일되지 않는다. 다만 **밀도가 이식 순서와 반비례한다** —
§5에서 먼저 가져오는 `terminal/`은 10/107이고 그나마 대부분 `import type` 1~2줄이다
(`TerminalWebView.tsx:4`, `terminal-webview-contract.ts:1-2`, `terminal-webview-html.ts:2` — 전부 타입).
반대로 `session/`은 115/310이라 §2.2에서 `session/[worktreeId].tsx`를 **통째 복사 금지**로 둔 이유가 여기 있다.
→ **완화**: 이식하는 타입만 `packages/herdr-client-ts`(이미 Metro가 볼 자리)에 재정의한다.

### 위험 2 — 단일 파일 5,333줄의 세션 화면

`app/h/[hostId]/session/[worktreeId].tsx`가 5,333줄이고 `tasks.tsx`는 15,168줄이다.
세션 화면 안에는 herdr에 필요한 것(연결 상태줄 L7 `:4191-4203`, 키보드 리프트 `:4205-4211`, pane 활성화 `:4122-4131`)과
필요 없는 것(네이티브 챗·diff·PR·파일)이 **한 컴포넌트에 섞여 있다**.
→ 통째로 가져오면 herdr에 없는 RPC 수십 개를 함께 끌고 온다. **훅·순수함수 단위로만 뽑아라.**

### 위험 3 — orca는 **데스크톱 PTY를 폰에 맞춰 리사이즈한다** (계획에 없던 발견)

`src/session/mobile-terminal-viewport-resubscribe.ts` **전체 293줄 + 테스트 333줄**이
"서버가 보고한 `cols/rows`가 폰 측정치와 같아질 때까지 **재구독**하는" 수렴 루프다
(`:42-65` 결정 함수, `:86-171` per-handle 예산, `:205-293` fit 패스, 상한 3회 `:7`, 백오프 `[0,750,3000]` `:12`).
`terminal.subscribe`의 params에 `viewport`가 들어가는 것(`rpc-client-terminal-subscription.ts:29-32`)이 그 증거다.

**herdr은 이 경로가 원천 차단돼 있다** — observe는 리사이즈하지 않고(§2.3), 그것이 계획의 핵심 결정이다.
→ 이 서브시스템은 **drop**이며, 동시에 **N4/N5(읽기 UX)에 orca 선례가 없다**는 뜻이다.
계획 §2.5의 "화면 레이아웃을 최대한 가져온다"가 **읽기 뷰포트만은 성립하지 않는다.**

### 위험 4 — **계획의 "pane 레벨이 없다"는 사실과 다르다** (§2.5 어긋남)

[`01-spec.md`](./01-spec.md):97과 [`02-architecture.md`](./02-architecture.md) §2.5는
*"orca는 tab = terminal 1:1이라 pane(split) 레벨이 없다. 이 한 단계는 신규 설계다"*라고 적는다. **아니다.**

- orca 데스크톱에 **layout leaf = pane**이 있다: `src/shared/agent-status-types.ts:107` —
  *"Composite key: `${tabId}:${leafId}` where leafId is a stable UUID layout leaf"*;
  `src/shared/dashboard-snapshot.ts:211` — *"leafId is null when the **pane** could not be resolved"*.
- 호스트는 터미널 서피스를 **`${parentTabId}::${leafId}`**로 발행한다
  (`scripts/mock-server-session-tabs-fixture.ts:15-16`, 실 fixture `:38-49`).
- 모바일은 그것을 **평탄화**한다 — `tabs[]`의 각 원소가 `{id: "tab-1::<uuid>", parentTabId, leafId, terminal}`
  (`src/session/mobile-session-route-types.ts:14-32`), 상위 tab 층은 `tabGroups[]`로 따로
  (`fixture:29-37`), 활성화 호출은 `leafId`를 실어 보낸다
  (`src/session/mobile-session-tab-activation.ts:13-21`).

**따라서 herdr의 `remote ▸ workspace ▸ tab ▸ pane` 4단은 신규 설계가 아니라 이식 대상이다.**
orca의 해법을 그대로 쓰면: **pane을 `${tabId}::${paneId}` 합성 키로 평탄화해 칩 스트립에 넣고, tab은 그룹 층으로 남긴다.**
[`01-spec.md`](./01-spec.md)의 "tab은 pane 그룹이므로 뷰어 안의 세그먼트로 평탄화한다"와 **정확히 같은 결론**이며,
계획이 "신규 설계"로 잡아 둔 일정 여유는 실제로는 이식으로 줄어든다.

> **다만 진짜 1:1인 제약은 따로 있다**: `resolveActiveSessionTab`이 **활성 서피스를 하나만** 돌려주고
> (`src/session/active-session-tab.ts:19-60`), `MobileSessionTab`이 `terminal: string | null`로
> **서피스당 터미널 1개**를 고정한다(`mobile-session-route-types.ts:22`).
> 즉 "동시에 여러 pane을 나란히 보기"는 orca에도 없다 — 한 번에 하나다.
> herdr 폰 UI도 그 제약을 받아들이면 이식이 거의 그대로 성립한다.

### 위험 5 — 상수의 짝이 문서가 아니라 주석으로만 묶여 있다

`GIVE_UP_AFTER_ATTEMPTS=12`(`rpc-client.ts:128`)와 `UNREACHABLE_ATTEMPTS=12`(`connection-health.ts:23`)는
**서로 정렬돼 있어야만** L3+L6이 함께 성립하고, 그 계약은 양쪽 주석(`rpc-client.ts:127`, `connection-health.ts:14-17`)에만 있다.
같은 형태가 `protocol-version.ts`의 4상수(README:147-152), `terminal-webview-html.ts:736`의 `scrollback:5000`에도 있다.
→ **herdr로 옮길 때 테스트로 고정하라.** 한쪽만 튜닝하면 "재시도는 계속하는데 UI는 영원히 '연결 중'"이 된다.

---

## 부기

- 이 문서는 340줄대로 [`CLAUDE.md`](../../../CLAUDE.md)의 200줄 기준을 넘는다. **분할 제안**:
  §3(전송 생존성 매핑)을 `09-orca-transport-linemap.md`로 떼면 §1·§2(이식표)와 §4~§6(설계·위험)이 각각 100줄대로 앉는다.
  단 §3은 [`05-orca-transport.md`](./05-orca-transport.md)와 1:1 대응이라 그 문서에 흡수하는 편이 더 낫다 — 오너 판단 대기.
- orca 클론은 세션 스크래치패드에만 존재한다. 재현: `git clone --depth 1 https://github.com/stablyai/orca.git` → `1ce2e562`.
