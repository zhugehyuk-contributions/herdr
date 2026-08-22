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

## 결정 7 — ssh 의존성 정확 핀 = **확정** (2026-08-23, 선택지 ② 채택)

이전 판은 "문서가 하부를 `apple/swift-nio-ssh`라고 적어왔는데 거짓이다"까지 밝히고 선택지 4개를
열어둔 채 멈춰 있었다. **이번 판이 그것을 닫는다.** 채택 = **②(Citadel과 nio-ssh를 정확 핀으로 고정)**.
③/④는 아래 §계보에서 근거가 약해졌고, ①은 암호 경로에 부동 홉 둘을 남기는 선택이라 기각한다.

이 결정을 **지금** 하는 이유는 타이밍이다: 이 머신엔 Xcode가 없어(`xcode-select -p` =
CommandLineTools) iOS 빌드가 불가능하고, 그래서 오늘 정하는 비용이 0이다. 첫 iOS 빌드일에 정하려
하면 빌드가 깨진 채로 버전 조합을 탐색하게 된다.

### 확정 핀

| 패키지 | 요구사항 | 리비전 |
|---|---|---|
| `orlandos-nl/Citadel` (직접) | `exactVersion 0.12.1` | `ae8562f895de06ccb86fdb1cbb65fd99c8976e12` |
| `Wellz26/swift-nio-ssh` (Citadel의 전이 의존, **루트에서 덮어쓴다**) | `revision` 직접 핀 | `a05e6bbe6b141ee68da3030e00275504c0595d4d` |

리비전 출처 = `modules/herdr-ssh/typecheck/ios/Package.resolved`(커밋돼 있음). 그 파일은 하부 8개
(swift-nio 2.101.3 · swift-crypto 3.15.1 · BigInt 5.7.0 …)까지 리비전 단위로 이미 적고 있다.

### 왜 0.12.1인가 — 고른 게 아니라 강제됐다

- `withExec`는 **0.12.1에서 처음 들어왔다**: 릴리즈 노트 본문 첫 줄이 *"add `withExec` for 8-bit-safe
  SSH exec channels by @thepaul in .../pull/123"* (published **2026-04-04**,
  <https://github.com/orlandos-nl/Citadel/releases>) `[v]`. 0.12.0 이하에는 pty 없는 exec 채널의
  8비트 안전 경로가 없다 → 계약(§exec 증거)을 만족하는 **하한**이 0.12.1.
- 그리고 0.12.1이 **최신**이다 — 2026-08-23 확인, 4.5개월간 후속 릴리즈 0건 `[v]`.
- 하한과 상한이 같은 점 하나다. "최신이 아니라 가장 안정적인 것"이라는 선택 여지가 애초에 없다.

### exec 채널 증거 (README 인용이 아니라 시그니처 + 컴파일)

체크아웃 실물 기준 (`typecheck/ios/.build/checkouts/Citadel`, 0.12.1 태그):

- **시그니처** `Sources/Citadel/TTY/Client/TTY.swift:456`
  `public func withExec(_ command: String, environment: [SSHChannelRequestEvent.EnvironmentRequest] = [], perform: (_ inbound: TTYOutput, _ outbound: TTYStdinWriter) async throws -> Void) async throws` `[v]`
- **pty 없음**: `withExec` → `_executeCommandStream(mode: .command(command))` → `SSHChannelRequestEvent.ExecRequest`
  (`TTY.swift:334`). pty 경로는 `.pty` / `.tty`로 별개 분기(`TTY.swift:266`)다 — 즉 pty 부재가 옵션이
  아니라 다른 함수다 `[v]`.
- **stdout/stderr 분리**: `public enum ExecCommandOutput { case stdout(ByteBuffer); case stderr(ByteBuffer) }`
  (`TTY.swift:47-51`) `[v]`.
- **exit status**: `case let status as SSHChannelRequestEvent.ExitStatus: onOutput(context.channel, .exit(status.exitStatus))`
  (`TTY.swift:134-135`) → `public struct CommandFailed: Error { public let exitCode: Int }` (`TTY.swift:173-176`) `[v]`.
- **리시트**: `npm run typecheck:ios` **2026-08-23 green** — `Build complete! (6.25s)` /
  `herdr-ssh: HerdrSshSession.swift type-checks against Citadel 0.12.1` `[v]`. 우리 코드가 위 네 가지를
  전부 실제로 호출하며 컴파일된다(`ios/HerdrSshSession.swift:192-213`). README보다 강한 증거다.

**단, exec 계약에 구멍이 둘 있다 — 라이브러리가 못 주는 것이다:**

1. **`exit-signal`이 없다.** `NativeChannelClose.signal`은 iOS에서 영구히 `null`이다. nio-ssh에는
   `SSHChannelRequestEvent.ExitSignal`이 존재하는데(`swift-nio-ssh/Sources/NIOSSH/Child Channels/ChildChannelUserEvents.swift:168`)
   Citadel의 `ExecCommandHandler`가 `ExitStatus`만 매치하고(`TTY.swift:134`) 신호는 버린다 —
   Citadel 전체에서 `ExitSignal|exitSignal` grep **0건** `[v]`.
2. **정상 종료의 exit code가 안 온다.** `_executeCommandStream`은 `exitCode != 0`일 때만 `CommandFailed`를
   던지고 0이면 스트림을 조용히 끝낸다(`TTY.swift:285-291`). `HerdrSshSession.swift:209-210`은
   `CommandFailed`에서만 exitCode를 읽으므로 **exit 0 → `exitCode: nil`**. Android 경로와 값이 갈릴
   수 있다(미검증, §확인 못 한 것 4).

### 키 포맷 — **Android와 패리티가 없다** (이번 조사의 최대 발견)

| 키 형태 | Android (sshj 0.40.0 + `loadKeys`) | iOS (Citadel 0.12.1) |
|---|---|---|
| ed25519, openssh-key-v1 | ✅ | ✅ |
| RSA, openssh-key-v1 | ✅ | 파싱은 되나 **인증이 죽는다**(아래) |
| RSA, 고전 PEM (`ssh-keygen -m PEM`) | ✅ | ❌ **컨테이너 단계에서 거부** |
| 암호화 키(passphrase) | ✅ | 라이브러리는 지원, **우리 코드가 거부** |

- **고전 PEM 거부의 위치**: `Citadel/Sources/Citadel/OpenSSHKey.swift:307-313` —
  `init(string key:)`가 `-----BEGIN OPENSSH PRIVATE KEY-----` 접두와 `-----END …-----` 접미를 하드
  가드하고 아니면 `InvalidOpenSSHKey.invalidOpenSSHBoundary`를 던진다. `Curve25519.Signing.PrivateKey(sshEd25519:)`
  (`SSHCert.swift:74`)와 `Insecure.RSA.PrivateKey(sshRsa:)`(`SSHCert.swift:108`)가 **둘 다** 이 경로를
  탄다 `[v]`. **Android에서 `loadKeys`로 고친 그 문제의 정확한 거울상이다** — Android는 고전 PEM만
  읽었고, iOS는 openssh-key-v1만 읽는다. 이번엔 라이브러리 밖에 다른 프로바이더가 없어 같은 방식의
  수리가 불가능하다.
- **RSA는 컨테이너를 통과해도 서명에서 죽는다**: `rsa-sha2` 문자열이 Citadel 0.12.1과 nio-ssh 0.3.6
  소스 전체에 **0건** `[v]`. 서명 접두는 `ssh-rsa`(SHA-1) 고정 —
  `Citadel/Sources/Citadel/Algorithms/RSA.swift:141` `public static let signaturePrefix = "ssh-rsa"`.
  OpenSSH **8.8**(2021-09-26)이 *"disables RSA signatures using the SHA-1 hash algorithm by default"*
  라고 못박았으므로(<https://www.openssh.org/txt/release-8.8>) **modern sshd 상대로 iOS의 RSA
  공개키 인증은 실패한다.** RFC 8332 지원은 Citadel PR #131 ← Wellz26 PR #3에 **아직 open**이다.
- **따라서 iOS는 실질적으로 ed25519 전용이다.** 이건 핀 결정의 부산물이 아니라 **B11급 사용자 대면
  제약**이므로 온보딩이 `ssh-keygen -t ed25519`를 지시해야 하고, RSA만 가진 유저는 iOS에서 막힌다.
  → **이 한 줄이 결정 7에서 유일하게 유저 확인이 남는 항목이다** (핀 자체는 가역이라 확인 불요).
- 암호화 키는 라이브러리 한계가 아니다: Citadel의 두 init 모두 `decryptionKey: Data? = nil`을 받는데
  (`SSHCert.swift:74`·`:108`) `HerdrSshSession.swift:68-72`가 스스로 거부한다. 우리 선택이므로 언제든
  되돌릴 수 있다.

### 최소 iOS 버전 = 17.0 (결정 5와 정합)

- Citadel 0.12.1 `Package.swift:8-11` = `platforms: [.macOS(.v14), .iOS(.v17)]`, tvOS 미선언 `[v]`.
  **main 브랜치도 동일** (2026-08-23 raw 확인) — 0.12.x 계열에서 내려갈 여지가 없다.
- `withExec`에 붙은 `@available(macOS 15.0, *)`(`TTY.swift:455`)는 macOS에만 거는 제약이고 와일드카드가
  나머지 플랫폼을 덮으므로 **iOS에는 추가 제약이 아니다**. 타입체크 하네스만 `.macOS(.v15)`가 필요한
  이유가 이것이다(`typecheck/ios/Package.swift:5`).
- `ios/HerdrSsh.podspec`은 이미 `:ios => '17.0'`으로 정정돼 있다.
- ⚠️ `app.json`의 iOS 배포 타깃과의 대조는 **하지 않았다** — 다른 에이전트가 편집 중이라 열지 않았다
  (§확인 못 한 것 1).
- 참고: `apple/swift-nio-ssh` 0.15.0은 `.macOS(.v10_15), .iOS(.v13), .watchOS(.v6), .tvOS(.v13)`
  (2026-08-23 raw 확인) `[v]` — 결정 5가 적은 "직접 쓰면 iOS 13까지 내려간다"는 사실이다.

### `Wellz26/swift-nio-ssh` — 왜 포크이고, 무엇을 고쳤고, 어디에 고정하나

- **왜 포크인가 = 우리 선택이 아니다.** Citadel **0.12.1과 main 둘 다** `Package.swift:20`에서
  `.package(url: "https://github.com/Wellz26/swift-nio-ssh.git", "0.3.4" ..< "0.4.0")`를 선언한다
  (main은 2026-08-23 raw 확인 `[v]`). apple 저장소는 Citadel의 의존성 목록에 없다. 우리에게 열린
  선택은 "apple을 쓸까"가 아니라 **"이 홉을 핀할까"**뿐이다.
- **무엇을 고쳤나 = 딱 한 줄.** `git show a05e6bb --stat` = `Package.swift | 1 +`,
  `1 file changed, 1 insertion(+)` — NIOSSH 타깃에 `.product(name: "NIO", package: "swift-nio")` 추가.
  커밋 메시지 *"fix: add NIO product dependency to NIOSSH target for Mac Catalyst compatibility"*,
  2026-04-02 `[v]`. Citadel PR #127로 상류에 들어왔다.
- **계보 정정**: 이전 판은 이를 "`Joannis/swift-nio-ssh`의 포크"라고 적었고 그건 맞다 —
  GitHub API `parent.full_name` = `source.full_name` = **`Joannis/swift-nio-ssh`**(Citadel 저자 본인
  저장소, default branch `citadel2`), created **2026-04-02**, pushed **2026-04-02**, ★0 `[v]`.
  다만 강조점이 바뀐다: **코드 본체는 Citadel 저자 계보이고, 이 개인 포크가 얹은 것은 위 한 줄뿐**이다.
  "개인 포크에서 온 암호 구현"이라는 표현은 과장이었다.
  (Joannis 쪽은 오히려 더 정체돼 있다 — 마지막 push **2025-09-16** `[v]`.)
- **버전 번호가 거짓말을 한다** `[v]` — 이 결정을 *리비전* 핀으로 미는 결정적 근거:
  | 태그 | 커밋 | 날짜 |
  |---|---|---|
  | `0.3.4` | `b93961a` | 2025-07-14 |
  | `0.3.5` | `791437a` | 2025-09-15 |
  | `0.4.0` | `c997b6b` | 2025-09-16 |
  | `0.3.6` | `a05e6bb` | **2026-04-02** |
  `c997b6b`(=`0.4.0`)는 `a05e6bb`(=`0.3.6`)의 **부모**다. 즉 **`0.3.6`이 `0.4.0`보다 새 내용**이며,
  Citadel의 `..< "0.4.0"` 범위 안에 들어가려고 상위 내용을 낮은 번호로 재태깅한 것이다.
  → **이 저장소에서 범위 제약은 의미가 없다. 정직한 핀은 리비전뿐이다.**
  (herdr가 프로토콜에서 이미 배운 것과 같은 교훈 — 버전 정수는 레이아웃/내용 식별자로서 죽는다.)
- **포크는 죽었지만 상류다**: 2026-04-02 이후 push 0. 그런데 open PR 3건이 걸려 있고
  (#1 keyboard-interactive · **#2 닫힌 자식 채널의 window-adjust `preconditionFailure` 크래시 픽스** ·
  #3 RFC 8332 기반작업), **Citadel의 open PR #130·#131이 각각 그 PR들에 의존한다고 본문에 명시**한다 `[v]`.
  → 선택지 **④(apple 복귀 제기)는 실효성이 낮다** — Citadel 로드맵 자체가 이 포크 위에 서 있다.
  → 그리고 #2는 우리 시나리오(채널을 반복해 여닫는 모바일 transport)와 정확히 겹치는 **프로세스
  종료급 크래시**다. 핀한다는 것은 그 크래시도 함께 고정한다는 뜻이며, 실기기 단계의 관찰 대상이다.

### 핀을 어디에 어떻게 기록하는가 — SwiftPM으로 실측했다 (Xcode 불필요)

지금 부동 홉은 둘이다: ① `mobile/plugins/with-herdr-ssh-spm.js`의 `kind: 'upToNextMinorVersion'`
(= `0.12.1 ..< 0.13.0`) ② Citadel → nio-ssh의 `0.3.4 ..< 0.4.0`. ②는 남의 매니페스트라 편집할 수 없다.
**루트에서 덮어쓸 수 있는지를 순수 SwiftPM으로 확인했다 (2026-08-23, Xcode 없음)** `[v]`:

| 실험 | 루트 선언 | 결과 |
|---|---|---|
| `/tmp/spmpin` | Citadel `exact: "0.12.1"` + Wellz26 `exact: "0.3.6"` | `swift package resolve` **exit 0**, resolved = `revision a05e6bb…` / `version 0.3.6` |
| `/tmp/spmpin2` | Citadel `exact` + Wellz26 `revision: "a05e6bb…"` | **exit 0**, resolved state = **revision만, version 필드 없음**(가장 단단) |

부수 확인: 두 실험 모두 **어느 타깃도 nio-ssh를 직접 링크하지 않았는데** 루트 의존성으로 정상
해석됐다 → Xcode 쪽에서도 `XCSwiftPackageProductDependency` 없이 `XCRemoteSwiftPackageReference`만
추가하면 되리라는 근거(단 pbxproj 경로 자체는 미검증, §확인 못 한 것 2).

**첫 `expo prebuild` 때 할 것 — `mobile/plugins/with-herdr-ssh-spm.js`의 `PACKAGES`를 이 형태로:**

```js
const PACKAGES = [
  { name: 'Citadel',
    url: 'https://github.com/orlandos-nl/Citadel.git',
    requirement: { kind: 'exactVersion', version: '0.12.1' },
    products: ['Citadel'] },
  // Citadel이 `0.3.4 ..< 0.4.0`으로 부동시키는 전이 홉을 루트에서 리비전 고정한다.
  // 이 저장소는 0.4.0보다 0.3.6이 새 내용이라 범위·버전 제약이 무의미하다(결정 7 참조).
  // products는 비운다 — NIOSSH는 Citadel이 링크한다.
  { name: 'swift-nio-ssh',
    url: 'https://github.com/Wellz26/swift-nio-ssh.git',
    requirement: { kind: 'revision', revision: 'a05e6bbe6b141ee68da3030e00275504c0595d4d' },
    products: [] }
]
```

현 코드는 `requirement`를 `{ kind, minimumVersion }`로 **조립**하므로, `requirement`를 통째로 받아
그대로 쓰도록 두 줄 고치는 편집이 따라온다(`objects['XCRemoteSwiftPackageReference'][referenceId].requirement = pkg.requirement`).
그리고 그 파일 상단의 `upToNextMinorVersion` 정당화 주석 블록은 **이 결정이 대체하므로 삭제 대상**이다.

**벨트 하나 더 (권고, 미검증)**: `modules/herdr-ssh/typecheck/ios/Package.resolved`가 이미 10개 핀 전부를
리비전 단위로 담고 커밋돼 있다. prebuild 후 이 파일을 생성된 iOS 프로젝트의
`ios/<Name>.xcworkspace/xcshareddata/swiftpm/Package.resolved`(또는 `.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/`)로
복사하면 Citadel 하부 8개까지 고정된다. 경로와 Xcode 수용 여부는 prebuild 산출물을 본 뒤 확정한다.

### orca는 무엇을 썼나 — **아무것도 안 썼다**

닫힌 전제("모르면 orca의 결정을 따른다")는 **여기서 발동하지 않는다**. `08-orca-port-map.md` N1이
그대로 적고 있다: *"orca 전체에 ssh 코드가 없다"*. orca의 전송은 RN이 기본 제공하는 WebSocket이고
(`05-orca-transport.md` 서두), 인증은 relay + pairing + E2EE다 — 포트맵에서 **61파일 9,046줄이 drop**
판정을 받은 바로 그 덩어리이며 "ssh가 대체한다"가 그 판정의 사유다. 따를 선례가 없으므로 **다르게
가는 것에 대한 해명 의무 자체가 성립하지 않는다.**

포트맵 N1이 괄호로 든 "iOS libssh2/NMSSH"는 orca의 선택이 아니라 **계획 문서의 추정**이었고, 두 후보는
이미 기각됐다 — `ios/HerdrSsh.podspec` 헤더 실측: CocoaPods trunk의 ssh 클라이언트는 NMSSH(마지막
릴리즈 2.3.1, **2018-07-29**)와 서드파티 libssh2 pod(1.4.3, **2014-05-19**)뿐이고 둘 다 2019년 이전
암호 스택을 벤더링한다 — 유저의 ssh 키를 쥔 앱에서.

### 확인 못 한 것

1. **`mobile/app.json`의 iOS 배포 타깃이 17.0 이상인지.** 다른 에이전트가 편집 중이라 열지 않았다.
   확인 방법 = prebuild 전에 `app.json`의 `ios.deploymentTarget` 또는 `expo-build-properties` 설정을
   podspec의 `:ios => '17.0'`과 대조. 불일치면 첫 prebuild에서 깨진다(결정 5가 이미 겪은 등급의 결함).
2. **pbxproj 직렬화가 Xcode에 받아들여지는지.** `xcode@3.0.1`에는 `XCRemoteSwiftPackageReference`
   모델이 없어 이 플러그인은 writer의 일반성에 기대고 있다(플러그인 헤더가 스스로 "모듈에서 가장
   취약한 파일"이라고 적었다). `kind = exactVersion; version = …;` / `kind = revision; revision = …;`의
   실제 수용 여부는 **Xcode 없이는 확인 불가** — 이 머신은 CommandLineTools뿐이고 시뮬레이터 0개다.
   확인하려면 Xcode가 깔린 머신에서 `expo prebuild --platform ios` 1회.
3. **`Package.resolved`를 어느 경로에 놓아야 Xcode가 읽는지.** CocoaPods 워크스페이스가 끼는 구성에서
   실측한 적 없다. 확인 = 2번과 같은 1회 prebuild.
4. **exit 0 / exit-signal의 실제 Android 대비 값 차이.** iOS 경로는 컴파일만 됐고 **한 번도 실행된 적이
   없다**. 확인 = 실기기 1회 + Android와 같은 브리지에 같은 명령.
5. **Android가 RSA를 실제로 `rsa-sha2`로 서명하는지.** `typecheck/keyformats/run.sh`는 **파싱만**
   증명하며 하네스 주석이 스스로 그렇게 적었다("소켓을 열지 않는다"). 즉 위 표의 Android RSA ✅는
   "키가 로드된다"까지다. 확인 = 실서버 대상 RSA 인증 1회(Android 잔존 항목과 동일).
6. **Wellz26 저장소의 태그 불변성.** `exactVersion`은 태그→커밋 결속을 신뢰하는데 이 저장소는 ★0
   개인 계정이고 이미 재태깅 이력이 있다(0.3.6 vs 0.4.0). **리비전 핀을 권고한 이유가 이것이다.**

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

**화면은 목업이 아니었다 (2026-08-22 정정)**: 직전 판은 "화면 데이터는 여전히 `mock-fixture.ts` 목업"이라고 적었다. **틀렸다.** 선택 이음매는 `herdr-data-provider.tsx`의 한 줄 `connections.length > 0 ? createLiveSnapshotLoader(connections) : loadMockSnapshot`이고, 기기에서 그 값은 **1**이었다(`{"connections":1,"failures":[]}`) → 라이브 로더가 선택됐다. 화면 증거도 일치한다: `app/index.tsx:44`의 `N nodes`는 `snapshot.perRemote.length`인데 **목업은 4 nodes와 에이전트 40개**를 낸다(실행 확인 `[v]`). 기기 스크린샷은 **`1 nodes` · `No agents on any node`** — 목업이 만들 수 없는 값이고, 원격 1개·에이전트 0개인 격리 랩 서버와 정확히 일치한다. 나는 화면을 열어보고도 "목업일 것"이라고 적었다 — 판별 가능한 값(노드 수)이 화면에 이미 있었다.

**툴체인 (다음 사람용)**: JDK **17** (Java 26은 `Unsupported class file major version 70`으로 gradle 실패) · Android SDK platform 36 + build-tools 36.0.0 · `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.

이 과정에서 결함 2건이 나왔고 둘 다 수정됐다 — gradle 평가 실패(`safeExtGet` 미정의)와 **모듈 등록 실패(`Class()`에 `Constructor` 필수)**. 후자는 컴파일로는 잡히지 않는다: `:herdr-ssh:assembleDebug`가 green이었고 스텁 타입체크도 green이었는데, Expo 빌더가 **등록 시점**에 던진다. 실행이 아니면 못 잡는 등급이다.

## 기기에서의 공개키 인증 — 해결 (2026-08-22)

**결과: 앱이 격리 스크래치 서버에 붙는다** `[v]`. 앱 로그 `{"connections":1,"failures":[]}`,
서버 측 herdr 로그 `client connected client_id=9 cols=80 rows=24 surface_mode=FullApp
render_encoding=TerminalAnsi`. 앱(Hermes) → HerdrSsh(Kotlin/sshj) → ssh exec →
`remote-client-bridge` → herdr 서버까지 전 구간이 실기기(에뮬레이터)에서 이어졌다.

**근본 원인은 키 프로바이더 하드코딩이었다.** 우리 코드가 `OpenSSHKeyFile`을 직접 생성했는데
이 프로바이더는 **고전 PEM(`BEGIN RSA PRIVATE KEY`)만** 읽는다. OpenSSH 7.8 이후 `ssh-keygen`이
만드는 키는 전부 openssh-key-v1 컨테이너(`BEGIN OPENSSH PRIVATE KEY`)라서 로드 자체가 안 됐고,
sshj는 서버에 publickey 수단을 **하나도 제시하지 않은 채** 끊었다. 수정 =
`client.loadKeys(privateKey, null, passwordFinder)` — `KeyProviderUtil.detectKeyFileFormat`이
헤더를 보고 `KeyFormat.OpenSSHv1`로 판별해 `DefaultConfig:158`에 등록된
`OpenSSHKeyV1KeyFile.Factory()`를 고른다. 두 포맷 모두 지원되고 어느 쪽도 하드코딩되지 않는다.

**증상이 원인을 가리지 않았다는 것이 교훈이다.** `UserAuthException: Exhausted available
authentication methods`는 "서버가 거절했다"로 읽히지만 실제로는 "우리가 묻지도 않았다"였다.
서버 DEBUG3 로그가 KEX 완주 + `ssh-userauth` 수락 **후 인증 시도 0건**을 보여준 것이 갈림길이었다.

**틀린 가설을 기록으로 남긴다** — 직전 판의 유력 가설은 "`BouncyCastleSetup`의 full BC 1순위 삽입이
`net.i2p.crypto:eddsa`와 충돌해 키가 서명 불가 형태가 된다"였다. **오답이다.** BC 삽입은 X25519 KEX에
필요하고 무해했으며, 조사 순서 ①(키가 로드됐는가 vs 서명 팩토리가 없는가)이 정답 축이었는데 ②(provider
위치)를 유력으로 올렸다. 증상에서 가설로 건너뛰지 말고 라이브러리 소스를 먼저 열었어야 했다.

**잔존**: RSA 키 경로는 여전히 **미판별**이다 — 오염된 로그 구간 때문에 판별을 포기했고, 수정 후에는
Ed25519로만 재현했다. `loadKeys`는 고전 PEM도 처리하므로 회귀 위험은 낮지만 실측은 없다.

