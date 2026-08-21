# herdr mobile — Spec

## 닫힌 전제 2개 (오너 확정 2026-08-22 — 재심의 대상 아님)

1. **herdr client를 모바일 네이티브 앱으로 만든다.** "앱을 지을지 말지"는 열린 질문이 아니다.
   `src/ui/mobile.rs`는 좁은 **터미널 뷰포트**용 TUI 레이아웃이지 앱이 아니고 앱의 대안도 아니다.
2. **orca mobile이 선택한 개발 방식("와꾸")을 최대한 그대로 이용해 개발 시간을 단축한다.**
   교훈만 이식하는 게 아니라 **프로젝트 스캐폴딩 · 디렉토리 구조 · 화면 레이아웃 · transport 계층 코드**를
   최대한 가져온다. herdr에서 성립하지 않는 것(페어링 · E2EE · 릴레이 — ssh가 대체)만 덜어낸다.
   → **설계가 갈릴 때 기본값은 "orca와 같게"**이고, 다르게 가려면 그 이유를 문서에 적어야 한다.
   이식 대장은 [`02-architecture.md`](./02-architecture.md) §2.5와 [`05-orca-transport.md`](./05-orca-transport.md).

---

herdr의 네이티브 모바일 앱. 폰에서 herdr 서버에 붙어 **에이전트 상태를 보고, pane 화면을 읽고,
승인을 눌러주는** 것이 목적이다. herdr의 다른 클라이언트와 같은 자격으로 붙는다 — 게이트웨이나
허브를 새로 만들지 않고, 전송과 인증은 ssh 그대로다. 이미 프로덕션에서 도는 경로
(`herdr remote-client-bridge` / `remote-api-bridge`, `src/remote/unix.rs:75-76` `[v]`)를 탄다.

레퍼런스 구현은 [orca](https://github.com/stablyai/orca)의 `mobile/` (Expo + React Native +
expo-router, xterm.js WebView 터미널). 구조와 transport 생존성 해법을 가져오되, orca의
페어링/E2EE/릴레이 계층은 herdr에서 필요 없다 — ssh가 그 역할을 한다.

Status: **기획만 존재. 앱 코드 0줄.** 이 문서군은 구현 전 계약이지 구현 기록이 아니다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

| | |
|---|---|
| 앱 코드 | **0줄** — 이 폴더는 아직 기획뿐이다 |
| 베이스 | `feat/mobile-client` @ `aa9f6e14` = v0.8.0-mx.1, protocol 20 |
| 게이트 | clippy clean · nextest **3574/3574** (1 flaky, 2 leaky) |
| 다음 | [`06-open-decisions.md`](./06-open-decisions.md)의 열린 결정 4개를 오너가 확정 → M0 착수 |

### 이 폴더

| | |
|---|---|
| `01-spec.md` | 이 문서 — 무엇을 만드는가. **계획 SSOT의 진입점** |
| `02-architecture.md` | 두 채널 · 읽기(observe+TerminalAnsi) · 쓰기(JSON API) · ssh 계층 · 앱 스택 |
| `03-blockers.md` | herdr 쪽이 먼저 바뀌어야 하는 것 (B1·B2·B4·B5·B6·B8~B12) |
| `04-milestones.md` | M0~M6, 각 단계의 "됐다" 기준 |
| `05-orca-transport.md` | orca transport 생존성 이식표 (L1~L7 · X1~X6 · P1) |
| `06-open-decisions.md` | 오너가 정할 것 4개 + 이전 판 대비 변경 |
| `07-research-2026-08-22.md` | 위 6편이 정리해 낸 원본 조사 전문. 근거를 더 파고들 때만. **충돌하면 01~06이 이긴다** |
| `assets/mockup.html` | UI 목업 7화면 + 계획 요약. **발행된 아티팩트의 소스** — 고칠 땐 이 파일을 편집해 같은 URL로 재발행 (https://claude.ai/code/artifact/5d23d155-8fe3-4be7-a0f7-dd2050d39806) |
| `assets/mockup-v5-original.html` | v0.6.8 기준 초판. 줄번호·계획이 낡았다, 화면 설계 참고용 |

목업 화면 설계는 **아직 오너 검증 전이다** (하단 네비 · pane 칩 전환 · 키 액세서리 행 구성).

### 빌드·테스트 (두 가지를 맞춰야 한다 — 안 그러면 코드 결함으로 오진한다)

```bash
export ZIG=/opt/homebrew/opt/zig@0.15/bin/zig   # 없으면 vendored libghostty-vt 빌드가 죽는다 (build.rs:116)
rustup run 1.96.1 cargo clippy --all-targets --locked -- -D warnings
rustup run 1.96.1 cargo nextest run --locked --retries 2
```

- PATH의 Homebrew cargo(1.97.x)가 `rust-toolchain.toml`(1.96.1)을 무시한다 → `rustup run 1.96.1`을 명시한다.
- **`cargo fmt --check`는 이 레포에서 신뢰할 수 없는 신호다.** 고정 툴체인에서도 12개 파일이 어긋나는데
  그 파일들은 fork가 건드리지 않은 upstream 원본과 바이트 동일하다. 근인 미규명. **판단은 clippy + nextest로 한다.**
- `live_*`는 부하 민감 플레이크가 있다 → `--retries 2`.

### 레퍼런스 (벤더링하지 않는다)

```bash
git clone --depth 1 https://github.com/stablyai/orca.git
```

특히 `mobile/issue-5049-unresponsive-session-findings.md` ·
`mobile/terminal-output-streaming-findings.md` · `mobile/src/transport/` — [`05-orca-transport.md`](./05-orca-transport.md)의 체크리스트가 여기서 나왔다.

### 관련 이슈

- **#70** Fleet upgrade window — 프로토콜 완전일치. 앱의 **선행 조건**이다([`03-blockers.md`](./03-blockers.md) B1).
  단 이슈 본문은 2026-07-16 이후 무갱신이고 **호환 창만으로는 부족하다**는 것이 이번 판의 결론이다(B1 표).
- **#68** 기본 브랜치 `mx`에 push CI 없음 — 위 fmt 항목의 배경이자 **M-1의 일부**([`04-milestones.md`](./04-milestones.md)).

---

herdr의 도메인은 **remote ▸ workspace(space) ▸ tab ▸ pane(=terminal)** 이고, agent는 pane 위에 얹힌
논리 뷰다. 폰에서는 이 4단 트리를 **3단 내비게이션 + 1개의 횡단 뷰**로 접는다.

- **Agents 화면 = 홈.** 전 서버 에이전트를 상태순(blocked → working → done)으로. 폰에서 사람이 실제로
  하는 일은 트리 브라우징이 아니라 "누가 나를 기다리나 → 그 화면 보고 → y 눌러주기"다.
- 리모트 목록 → 워크스페이스 목록(행마다 idle/working/blocked 롤업) → pane 뷰어. tab은 pane 그룹이므로
  뷰어 안의 세그먼트로 평탄화한다.

**orca와 같은 것**: master-detail 레이아웃, 호스트당 공유 클라이언트 1개, xterm.js-in-WebView 렌더러,
transport 생존성 계층, 설정/연결로그/트러블슈팅 화면.

**다른 것**:
- orca는 tab = terminal 1:1이라 **pane(split) 레벨이 없다.** 이 한 단계는 신규 설계다.
- orca의 pairing/E2EE/relay는 통째로 사라진다. herdr은 인증이 ssh 자체고 와이어에 auth 필드가 없다.
- orca의 `git.*`/`files.*`/tasks 화면은 herdr JSON API에 대응 메서드가 없어 v1에서 드랍한다.
  herdr에서 git은 pane 안에서 산다.

---
