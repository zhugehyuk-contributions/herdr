# 06 — 확정된 결정 · 열린 결정 · 이전 판 대비 변경

## 확정 (2026-08-22 — 근거는 전부 이 판에서 직접 실측)

- **D5 · M0 순서 = 지반 동기화 후.** upstream **v0.8.2**(= 최신 릴리즈 태그, `v0.8.0..v0.8.2` = **133커밋**) + #68을
  **M-1**로 선행([`04-milestones.md`](./04-milestones.md)). `update-upstream` 규약상 머지 단위는 브랜치 HEAD가 아니라 릴리즈 태그다
  (`master`는 v0.8.2보다 15커밋 앞설 뿐이라 단위가 줄지 않는다).
  되돌리기 비용이 비대칭이기 때문 — 동기화 먼저 = M0 사이클 1회 지연(**가역**),
  M0 먼저 = 빨간 테스트 아래 머지 + 픽스처 재생성(**비가역**).
- **D6 · M0 구현 위치 = fork(herdr-mx).** M0-a(레이아웃 지문)는 정의상 upstream이 가질 물건이 아니고,
  upstream 수용 리드타임은 통제 밖이다. M0-b(호환 창)만 사후 additive PR로 upstream에 제안한다.
- **D7 · `mobile/` = in-tree (`herdr-mx/mobile/`).** upstream 트리에 `mobile/` 경로가 없어
  **이번 동기화 기준으로 같은 경로의 직접 충돌이 없다** — in-tree의 주된 반대 논거가 사실상 사라진다.
  (절대 보장은 아니다: upstream이 나중에 같은 경로를 추가하거나 루트 CI/워크스페이스 설정이 충돌할 수 있다.) 게다가 픽스처 코퍼스가 Rust(생성)↔TS(소비)를
  가로지르므로 같은 레포면 커밋 1개로 원자적이고, 레포를 가르면 publish/pin 계약이 된다(1인 팀에서 가장 먼저 썩는 종류).
  되돌리기도 비대칭 — in-tree→형제는 `git subtree split`(히스토리 보존) 1커맨드, 역방향은 이미 낸 동기화 세금이 환불되지 않는다.
  전제 2(orca 와꾸 최대 재사용)와도 맞는다 — orca 자신이 `mobile/`을 in-tree로 둔다.
  - **동반 필수 (D7과 같은 배치로)**: ① `.gitignore`에 `mobile/`·`packages/` JS 산출물 항목
    (현 `.gitignore`엔 JS 항목이 **0개**였다 `[v]` → 2026-08-22 추가함)
    ② `mobile/`을 **cargo 워크스페이스 멤버로 넣지 않는다**(Rust 게이트 오염 금지)
    ③ 앱 게이트: `mobile/**`·`packages/**` 경로의 tsc+vitest 잡 — **#68로 `mx` push가 CI를 타게 된 다음에** 의미가 생긴다
    ④ 픽스처 최신성 잡 — upstream 동기화가 태그를 밀었을 때 울리는 **유일한 종**이다.

### 이 결정을 뒤집는 것 (반증 조건)

| 관측하면 | 뒤집히는 것 |
|---|---|
| 유저가 **upstream herdr을 서버로** 돌린다(mx 아님) | D6 붕괴 — 앱은 upstream 레이아웃을 타깃해야 하고 M0는 upstream PR이 정답 |
| **upstream 동기화를 그만둘** 작정이다(영구 fork) | D5의 순서 논거 사망, M0-a의 가치도 절반 |
| 148커밋 머지가 **다일 규모 난항** | D5 유지하되 M0를 **버릴 스파이크**로 병렬 착수(산출물은 동기화 후 재생성 전제) |
| 앱을 **mx 외 사용자에게 배포**할 계획 | D7 뒤집힘(형제 레포 + 독립 릴리즈). 추가로 `Ping`/`Pong`/`RequestFullFrame`이 upstream에 없어 [05] L1·X1 재설계 필요 `[v]` |

---

## 결정 4개 — 2026-08-22 권고안으로 채택 (구현 착수 지시에 따름)

유저가 "herdr-mx mobile client 구현"을 지시했다. 각 항목의 **권고안을 기본값으로 채택**하고 착수한다.
되돌리기 비용이 큰 것은 1번뿐이며, 아래에 채택 근거와 재검토 트리거를 남긴다.

| # | 채택 | 근거 | 재검토 트리거 |
|---|---|---|---|
| **1 렌더러** | **`TerminalAnsi` + xterm WebView** | 코덱 부담 최소(손코덱 3종) · orca 재사용 최대(전제 2) · 동결 대상 5필드 · **2026-08-22 리시트로 경로 자체가 실증됨** | **B13 대역폭**이 셀룰러에서 실사용 불가로 판명되면. **2026-08-22 upstream v0.8.2 머지로 이 트리거는 크게 멀어졌다**: upstream #2675가 `write_all_cells`를 압축해 100×30 풀 프레임이 **55,925 B → 3,276 B(약 1.09 B/cell)**로 떨어졌다 `[v]`. 무압축(`Terminal`은 여전히 deflate 미적용)이라는 사실은 그대로지만 페이로드가 17배 작다. 그래도 불가로 판명되면 완화 ①(ANSI 분기에도 deflate)을 먼저 시도하고, 그래도 안 되면 `SemanticFrame`으로 전환 — 그때 코덱 포팅 비용이 되살아난다 |
| **2 pane 뷰 폭** | **PTY 폭 그대로 + 핀치줌/가로스크롤** (서버 변경 0) | B4의 v1 답. `Hello`의 cols/rows를 폰 해상도가 아니라 **대상 pane 실제 크기**로 보낸다 | M2 (e)에서 "수동 이동 후 도달"이 실사용에 부족하면 → auto-pan(커서 추종) 추가 |
| **3 홈 화면** | **Agents 우선** | 폰에서 사람이 실제로 하는 일은 트리 브라우징이 아니라 "누가 나를 기다리나 → 보고 → y" | — |
| **4 폰 ssh 키** | **`authorized_keys`의 `command=` 제한 + 브리지 디스패치 래퍼** | B11. 폰 분실 시 셸 전체가 열리는 것을 막는다. 서버 변경 0, 서버마다 한 줄 설치 | 설치 마찰이 실제로 채택을 막으면 → 무제한 키를 옵트인으로(위험 명시) |

**1번은 M1 선행이었고, 이로써 해제됐다.**

---

## M-1 실측 (2026-08-22) — 반증 조건 R3 발동

`update-upstream` 규약상 머지 단위는 **최신 upstream 릴리즈 태그 = `v0.8.2`**다(`master`가 아니다).
실측: `v0.8.0..v0.8.2` = **133커밋**, `merge-tree` 충돌 **27개 파일**(`src/protocol/wire.rs` ·
`src/server/headless.rs` · `src/client/mod.rs` · `src/main.rs` 포함). `master`는 v0.8.2보다 15커밋 앞설 뿐이라
쪼개도 단위가 줄지 않는다. v0.8.2에도 B1의 갈라짐이 그대로 있다 `[v]` — 근거는 실제 머지 대상에서 성립한다.

→ **R3 발동**("다일 규모 난항"). 처방대로 **D5는 유지**(M0의 동결·픽스처는 동기화 후)하되,
**M1은 병렬 착수한다.** 안전한 이유: `update-upstream` 규약이 **"upstream이 중간 삽입한 variant는 enum tail로
이동, 기존 wire tag 불변이 계약"**이고 **upstream 바이너리와의 wire 호환은 비목표**라고 명시한다 —
즉 **mx의 태그는 머지를 넘어 보존되므로 지금 쓰는 TS 코덱은 머지 후에도 유효**하다.
(이는 B1의 ABI 게이트 결론을 약화시키지 않고 강화한다: 갈라짐은 사고가 아니라 **정책**이므로,
그 정책을 기계가 확인하게 만드는 명시적 ABI 식별자가 정확히 옳은 산출물이다.)

---

## 열린 결정 (원문 — 위 표의 채택 근거)

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

1. **렌더러.** `TerminalAnsi` + xterm WebView(권장: 코덱 부담 최소, orca 재사용 최대, 동결 대상 5필드.
   **단 실측 비용 2개**: ⓐ xterm 종속 — 셀을 자기 UI로 재해석 불가 ⓑ **대역폭** — 풀 프레임이 압축 없이
   ~18.6 B/cell로 온다([`03-blockers.md`](./03-blockers.md) B13 `[v]`). semantic 경로는 deflate를 받는데 ANSI 경로는 못 받는다)
   vs `SemanticFrame` + 네이티브 셀 렌더러(자유도 높고 herdr UI를 폰용으로 재해석 가능, 대신
   bincode/FNV/deflate/델타를 전부 손으로 + 매 범프마다 유지보수). **한 번 고르면 되돌리기 비싸다.**
2. **pane 뷰 폭 정책.** PTY 폭 그대로 렌더 + 핀치줌(서버 변경 0, 지금 가능) vs observe 뷰포트를 herdr에
   추가(폰에 딱 맞지만 서버 작업). 근거는 [`03-blockers.md`](./03-blockers.md) **B4(좌상단 크롭)** —
   observe는 리플로우하지 않으므로 이 결정을 안 하면 M2가 **잘린 코너**를 보여준다. **전자가 v1 권고.**
3. **홈 화면.** Agents 우선(폰에서의 실제 용도) vs 리모트/워크스페이스 트리 우선(orca 구조에 더 가까움).
4. **폰 ssh 키 권한 범위.** 제한 없는 유저 키(간단, 분실 시 셸 전체) vs `authorized_keys`의 `command=`
   강제 + 브리지 디스패치 래퍼(안전, 서버마다 한 줄 설치).

---

## 이전 판(v0.6.8 기준) 대비 무엇이 바뀌었나

- **베이스 교체.** 이전 판은 `feat/multi-remote-client`(v0.6.8) 기준이었다. 그 브랜치는 `mx`보다 561커밋
  뒤였고 multi-remote는 이미 상륙해 있었다(`src/main.rs:550` `[v]`). 모든 줄번호가 무효였다.
- **코덱 포팅이 대부분 사라졌다.** 이전 판은 "bincode를 TS로 포팅 + 네이티브 셀 렌더러"로 직행했다.
  인코딩이 연결 모드와 직교한다는 사실([`02-architecture.md`](./02-architecture.md) §2.2)이 그 작업의 대부분을 지웠다.
- **attach → observe.** 이전 판은 `TerminalAttach`를 pane 표면으로 쓰고 "PTY가 폰 크기로 고정되는 것"을
  감수 비용으로 적었다. `ObserveTerminal`은 그 비용이 없다([`02-architecture.md`](./02-architecture.md) §2.3).
- **S1(attach 재진입 누수)은 이 베이스에 존재하지 않는다.** 재확인 결과 해제 경로와 이를 고정하는
  테스트가 있다 `[i]`. 백로그에서 제거.
- **프로토콜 항목이 "출시 전 필수"에서 "M0 선행"으로 승격됐다.** 범프 빈도를 실측했기 때문([`03-blockers.md`](./03-blockers.md) B1).

## 결정 5 — iOS 최소 지원 버전 = **17.0** (2026-08-22 강제 발견, 유저 확인 필요)

지금까지 `.prd` 어디에도 iOS 최소 버전이 적힌 적이 없다. 그런데 **이미 정해져 있었다** — 우리가 고른
ssh 라이브러리가 정하고 있었고, 아무도 그걸 읽지 않았다.

- **사실 `[v]`**: Citadel 0.12.1 `Package.swift` = `platforms: [.macOS(.v14), .iOS(.v17)]`, **tvOS 미선언**.
  모듈 podspec은 `:ios => '15.1', :tvos => '15.1'`이었다 — SwiftPM이 해석 자체를 거부하므로
  **첫 `expo prebuild`에서 깨진다.** 컴파일 0회였기 때문에 지금까지 안 보였다.
  (2026-08-22 `ios/HerdrSsh.podspec`을 17.0으로 정정, tvOS 삭제.)
- **대가**: iOS 15·16 기기가 대상에서 빠진다. iPhone 8/X 세대까지가 iOS 16이 마지막이다.
- **대안 `[v]`**: `apple/swift-nio-ssh` 0.15.0을 직접 쓰면 `.iOS(.v13)`까지 내려간다. Citadel은 그 위에
  얹힌 계층이므로, 내려가는 비용 = `withExec`(pty 없는 exec 채널)·`SSHAuthenticationMethod`·
  `SSHHostKeyValidator`를 **유저의 ssh 키를 쥔 앱에서 직접 구현**하는 것이다.
- **판단이 필요한 지점**: 이 앱의 대상 기기가 유저 본인 위주라면 17.0은 비용이 아니다(현행 유지).
  배포 대상이 넓어지면 그때 nio-ssh 직접 구현을 재평가한다. **기본값은 17.0 유지**로 두되,
  이건 선택된 적 없는 결정이었으므로 유저 확인 대상으로 올린다.

## 결정 6 — Swift 6 동시성 모드 (2026-08-22, 실측으로 확정)

`HerdrSshSession.swift`는 **Swift 5 모드에서만 컴파일된다** `[v]`. `NSLock.lock()/unlock()` 호출
16곳이 `async` 컨텍스트 안에 있고, `noasync` 가용성은 Swift 5에서 경고 · **Swift 6에서 에러**다.

- podspec은 지금 Swift 6 검사를 끄고 있으므로 **현행 설정에선 빌드된다.**
- 다만 이건 유예지 해결이 아니다. Swift 6 모드로 올리는 순간 16곳이 전부 막힌다.
- 실제 위험도는 별개로 낮다 — 확인 결과 lock/unlock 사이에 `await`가 없어 락을 await 너머로
  들고 가지 않는다. 즉 **정확성 문제가 아니라 마이그레이션 부채**다.
- 재현: `npm run typecheck:ios` (Swift 5, green) / `Package.swift`의 `swiftLanguageMode(.v5)`를
  빼면 red.

## 결정 7 — ssh 프로토콜 구현의 실제 출처 (2026-08-22, 공급망 실측 — **유저 확인 필요**)

문서(이 `.prd` 포함)는 하부가 `apple/swift-nio-ssh`라고 적어왔다. **거짓이다** `[v]`.

- Citadel 0.12.1 `Package.swift:20` = `https://github.com/Wellz26/swift-nio-ssh.git`,
  범위 `"0.3.4" ..< "0.4.0"`, 해석 결과 **0.3.6**.
- 그 저장소: `Joannis/swift-nio-ssh`(Citadel 저자 본인 포크)의 **포크**, 2026-04-02 생성,
  **같은 날 1회 push 후 커밋 없음**, 스타 0. Citadel PR #127(*"Fix: Add swift-nio dependency for
  Mac Catalyst builds"*, 2026-04-04 머지)로 들어왔다.
- 대조: `apple/swift-nio-ssh`는 2026-07-28까지 활발, 스타 515.
- **왜 중요한가**: 이 앱은 유저의 ssh 개인키를 쥔다. 그 키로 말하는 프로토콜 구현이 (a) 개인 포크에서
  오고 (b) `0.3.4 ..< 0.4.0` 부동 범위라 새 0.3.x가 자동 채택되며 (c) 우리 쪽 Citadel 핀도
  `upToNextMinorVersion`이라 **암호 경로에 부동 홉이 둘**이다.
- 선택지: ①현행 유지(가장 싸다, 위 사실을 알고 받아들임) ②Citadel과 nio-ssh를 **정확 핀**으로
  고정(부동 홉 제거, 업데이트를 명시적 결정으로) ③`apple/swift-nio-ssh` 직접 사용(결정 5의 대안과
  같은 비용 — `withExec` 등을 직접 구현) ④Citadel 상류에 apple 저장소 복귀를 제기.
- **권고: ②를 지금, ③/④는 실기기 검증 이후.** 판단은 유저 몫이라 결정으로 올린다.

## 실기기 검증 결과 — Android (2026-08-22, 에뮬레이터 실측)

**Android 경로는 끝까지 돌았다.** API 36 arm64 에뮬레이터(`herdr-test` AVD)에서:

| 단계 | 결과 |
|---|---|
| `expo prebuild --platform android` | ✅ (레포 오염 0) |
| autolinking | ✅ `herdr-ssh -> ['herdr-ssh']` (모듈 27개 중 우리 것 포함) |
| `:herdr-ssh:assembleDebug` | ✅ AAR, 클래스 25개 (`HerdrSshModule$definition$…$inlined$AsyncFunction$1..3` 포함 = Expo DSL이 **진짜** expo-modules-core로 특수화됨) |
| `:app:assembleDebug` | ✅ `app-debug.apk` 246MB |
| APK 내용 | ✅ `dev.herdr.ssh` 클래스 140개 · `net.schmizz`(sshj) 엔트리 3,711개 |
| 설치·실행 | ✅ 크래시 없음 |
| Hermes JS 로드 | ✅ Metro가 **3,243 모듈** 번들 → 앱이 수신 |
| UI 렌더 | ✅ agents 뷰(모노톤, blocked 8 / working 16, 하단 탭 nodes\|agents) |

**아직 아닌 것 — 정확히 하나**: 화면 데이터는 `src/api/mock/mock-fixture.ts` 목업이다. **기기에서 실제 ssh로 herdr 서버에 붙는 경로는 미실증**이다(에뮬레이터에 키·원격 미설정). 이걸 닫으려면 격리 스크래치 서버 + 폐기용 키가 필요하며, 유저 실인프라·실키를 에뮬레이터에 넣는 것은 하지 않는다.

**툴체인 (다음 사람용)**: JDK **17** (Java 26은 `Unsupported class file major version 70`으로 gradle 실패) · Android SDK platform 36 + build-tools 36.0.0 · `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.

이 과정에서 결함 2건이 나왔고 둘 다 수정됐다 — gradle 평가 실패(`safeExtGet` 미정의)와 **모듈 등록 실패(`Class()`에 `Constructor` 필수)**. 후자는 컴파일로는 잡히지 않는다: `:herdr-ssh:assembleDebug`가 green이었고 스텁 타입체크도 green이었는데, Expo 빌더가 **등록 시점**에 던진다. 실행이 아니면 못 잡는 등급이다.

## 다음 링크 — 기기에서의 공개키 인증 (2026-08-22, 미해결)

ssh **전송**은 기기에서 동작한다. 앱이 격리 스크래치 서버(폐기 sshd + 폐기 키, adb reverse)와
전체 핸드셰이크를 완주한 것이 서버 측 `LogLevel DEBUG3` 로그로 확인됐다 `[v]`:
`remote software version SSHJ_0.40.0` → `kex: algorithm: curve25519-sha256` → `KEX done` →
`ssh-userauth` 서비스 수락(`send packet: type 6`).

**막힌 곳은 그 다음이다.** 서버가 userauth 서비스를 수락한 뒤 **클라이언트가 인증 시도를 한 건도
보내지 않고** 끊는다 — 앱에는 `UserAuthException: Exhausted available authentication methods`로
보인다. 즉 sshj가 주어진 개인키로 쓸 수 있는 인증 수단을 만들지 못한다.

확인된 사실:
- 같은 키·같은 sshd로 **호스트 `ssh`는 성공**한다(`HOST_SSH_OK`) → 서버·authorized_keys·키 자체는 정상.
- `OpenSSHKeyFile.init(String, String)`은 경로가 아니라 **내용**을 받는다(`StringReader`,
  sshj 0.40.0 `OpenSSHKeyFile.java:73`) → 우리 호출 방식은 맞다.
- Ed25519(OpenSSH 포맷) 키에서 재현. RSA 키로도 앱 측 오류 메시지는 동일했으나, 그 시도가
  디버그 sshd에 도달했다는 서버 측 증거를 얻지 못해 **RSA는 미판별**로 남긴다(구 sshd가 살아 있던
  구간과 겹쳐 오염됐다 — 같은 포트에서 dispatcher가 돌린 호스트 `ssh` 성공 로그와 혼동할 뻔했다).

**유력 가설(미검증)**: `BouncyCastleSetup`이 full BC를 1순위로 삽입하는 것과 sshj의 EdDSA 처리
(`net.i2p.crypto:eddsa`)가 충돌해, 키는 파싱되지만 서명 가능한 형태가 되지 못한다. X25519 수정 없이는
KEX 자체가 불가능했으므로 이 삽입은 되돌릴 수 없고, 대신 **삽입 위치·범위를 좁히는 방향**이 다음 수다.

**다음 조사 순서**: ① 앱에서 `client.getUserAuthFactories()`/키 로드 결과를 직접 로깅해 "키가
로드됐는가 vs 서명 팩토리가 없는가"를 가른다 ② provider 삽입을 `insertProviderAt(…, 1)` 대신
`addProvider`(맨 뒤)로 두고 X25519가 여전히 잡히는지 본다 ③ RSA를 깨끗한 단일 sshd에서 재판별한다.

