# 00 — 드라이버 (여기부터 읽는다)

**"herdr-mx/mobile 개발 진행해줘"를 받으면 이 파일만 읽고 다음 행동이 결정돼야 한다.**
결정이 안 되면 그건 이 파일의 결함이다 — 작업 끝에 여기를 갱신하는 것이 작업의 일부다.

---

## 목표 (유저 원문, 2026-08-25 재확인 — 조건 5개)

> 1. herdr 모바일 터미널 앱 (휴대폰으로 내 원격 터미널 에이전트 사용)
> 2. orca mobile 와꾸를 이용하여 대부분 모르겠으면 orca mobile에서 결정한 내용을 사용
> 3. android와 ios앱을 만들고 각각 qa 절차대로 컨펌 (반드시 별도 에이전트가 qa 완료 판정 해야함)
> 4. 목업 이미지같은 모던한 ui QA 필수
> 5. qr 코드 로그인 기능 꼭 추가 (생각해보니 이거 필수임 ssh 접속 키 때문에)

**닫힌 전제 — 재심의 금지.** ①네이티브 앱을 짓는다(TUI 레이아웃은 대안이 아니다) ②orca mobile 와꾸를
최대 재사용하고, **모르는 것은 orca의 결정을 따른다**([`08-orca-port-map.md`](./08-orca-port-map.md))
③완료 = Android **와** iOS 둘 다, 각각 **별도 에이전트** QA 컨펌 ④UI 정본은
[`assets/mockup.html`](./assets/mockup.html) ⑤QR 로그인은 선택이 아니다(ssh 키를 손으로 못 옮기니까).

조건 2는 **분쟁 해결 규칙이기도 하다** — 목업과 orca가 갈리고 스펙이 그 영역을 미검증으로 두면
orca가 이긴다(`06-open-decisions.md` 결정 8이 그 적용례).

**"됐다"의 정의**: 코드가 있는 게 아니라, **해당 플랫폼에서 QA를 통과하고 그 판정을 별도 에이전트가
내렸을 때** 닫힌다.

---

## 지금 상태 (2026-08-25 오후 — 서버 작업 3건 전부 닫힘, 조건 4는 재QA 필요로 재개방)

**서버 작업 3건 + 위생 1건이 이 날 오후 스윕으로 닫혔고**(아래 §N-A), 같은 스윕이 **조건 4를
다시 열었다**: iOS가 7라운드 내내 산세리프로 렌더되고 있었다(타이포 결함, `.prd/09` §SS —
`'monospace'`는 Android 전용 generic). 수리는 착지(`fd42c472`), **기기 확증은 미완**. 여기에
신규 UI 표면 3종(요약줄 소스 전환·keybindings 세그먼트·show qr 오버레이)이 추가됐으므로
**재QA 라운드(Android 8차 · iOS 12차)가 최우선이다** (§N-QA).

| 조건 | Android | iOS | 남은 것 |
|---|---|---|---|
| 1 폰으로 원격 에이전트 사용 | ✅ 라이브 확증 | ✅ 라이브 확증 (`ZQ11-LIVE-PROOF`) | — |
| 2 orca 와꾸 | ✅ 이식 지도 15/15 | ✅ | — |
| 3 별도 에이전트 QA | ✅ 7차 PASS | ✅ 11차 PASS | 재QA(아래) 후 재판정 |
| 4 목업 대조 UI QA | 7라운드 PASS·누락 0 — 단 서체 축은 우연 통과(§SS) | 11차 PASS가 **서체 축에서 무효**(§SS) | **재QA 라운드** — 타이포 실렌더 + 신규 표면 3종 |
| 5 QR 로그인 | ✅ **실제 스캔 실측** | 화면·권한·폴백 ✅ / **실제 스캔 판정불가** | **실기기** (+데스크톱 show qr 실서버 실측) |

| 마일스톤 | 코드 | Android | iOS |
|---|---|---|---|
| M-1 지반 동기화 · M0 와이어 ABI · M1 `herdr-client-ts` | ✅ | — | — |
| M2 읽기 전용 앱 | ✅ | ✅ 5/5 | ✅ 5/5 |
| M2b 원격 설정 + 키 보관 | ✅ | ✅ 3/3 | ✅ (11차에서 settings 폼 확인) |
| M3 입력 | ✅ | ✅ 4/4 | ✅ 바이트 11/11 동일 |
| M4 transport 생존성 | ✅ | ✅ 강제종료 0 | ❌ 시뮬로 안 닫힘 → **실기기** |
| M5 푸시 | 서버·앱 ✅ / 센더 ❌ | ❌ | ❌ (**Expo 계정 게이트**) |
| M6a 스와이프 리타겟 | ✅ | ✅ 184ms | ✅ **닫힘** (N1, 페이지가 보고하는 경로 6/6) |
| M6b 제어 승격 | ⛔ 삭제 — §2.3과 모순 | — | — |
| M6c 스크롤백 | ✅ | ✅ | ✅ 7/7 |
| **조건 5 QR** | ✅ 파서·인계·`/pair`·`herdr pair` | ✅ 실스캔 | 빌드 수리 완료(§조건 5) |

**iOS 조건 5는 닫혔다** (2026-08-25). `expo-camera`가 `Pods.xcodeproj`의 프로젝트 객체를 SPM
참조에게 빼앗기던 것이 원인이었고 `scripts/pods-install.sh`가 그 충돌만 수리한다. 판정관이 bare
`pod install`로 되돌려 동일 서명을 재현한 뒤 스크립트로 복구까지 확인했다 — 우연 통과가 아니다.
**`pod install`을 직접 부르지 마라.**

**알려진 잔여 한계 (§P, 회귀 아님)**: 213컬럼 pane의 **마지막 7~9열이 어떤 배율에서도 도달 불가**.
`cellW × cols = 1630 CSS` vs 실제 도색 폭 ~1700 CSS의 가로 전용 메트릭 불일치이며, 수리 전후
클램프 산술이 동일함이 실측으로 확정됐다.

## 이력 — 아래부터는 판정 기록이다 (다음 행동을 정할 때는 읽지 않아도 된다)

### iOS 재QA (2026-08-23, 별도 에이전트, 고정 워크트리 `qa-ios-m2` @ `25e54ae8`)

**첫 QA를 막던 두 결함은 둘 다 닫혔다** — 그리고 그 뒤에 있던 것이 드러났다. 원장 = `.prd/09` §T·§U.

- **D2 PASS** (ssh write 레이스, `25e54ae8`) — 강제종료 후 재기동 10/10 라이브. 화면 문구
  `the ssh channel is no longer open` 0건이면서 **그 문자열이 바이너리에 여전히 존재함을 `nm`으로 확인** —
  "문자열이 사라져서 안 뜬 것"이 배제됐다.
- **D1 PASS** (safe-area, `78b80b35`) — 세로 `settings` 탭이 실제 전이. 버튼 y 31.7 → **69.67** ≥ 상태바 54.
  덤: `useSafeAreaInsets()` 경로는 이 수리 전까지 **어떤 라우트도 마운트한 적이 없었고**, 첫 프레임이
  그려진 것이 그 경로가 throw하지 않는다는 증거다.

**M2를 열어두는 것은 이제 §U다** — pane이 구독하고 observe 프레임 150,633B(랩 고유 문자열 포함)를
받는데 **터미널이 한 픽셀도 안 그린다.** Android는 같은 코드로 정상. 첫 QA는 D2에 막혀 여기 온 적이
없으므로 회귀가 아니라 *이제야 보이는* 결함이다.

### iOS 트랙 — 2026-08-23 열림

**Xcode 26.6 설치 확인** (`/Applications/Xcode.app`, Build 17F113). 이 트랙을 막던 유일한 유저 게이트가 풀렸다.

다만 **Xcode 설치만으로는 시뮬레이터가 생기지 않는다** — 설치 직후 `xcrun simctl list runtimes`가 비어 있고
디바이스 타입만 42종 있다. `xcodebuild -downloadPlatform iOS`로 런타임(iOS 26.5 Simulator, **8.52 GB**)을
따로 받아야 한다. 이걸 모르면 "Xcode 깔았는데 시뮬레이터가 0개"에서 막힌다.

진행 중: prebuild(`mobile/ios/` 생성) + 런타임 다운로드 병렬.

**iOS 첫 실행 전에 알아둘 것** — Android 전례가 그대로 적용된다: `assembleDebug`가 green인데
**Expo 모듈 등록이 실행 시점에 던졌다**(`.prd/06:165`, `Class()`에 `Constructor` 필수). 컴파일 통과를
성공으로 읽지 마라. iOS도 같은 등급의 결함이 실행에서만 나올 수 있다.

---

## ⛔ 유저 게이트 — 에이전트가 못 넘는 것 (2026-08-23 실측)

이 둘은 판단이 아니라 **계정 액션**이다. Xcode 설치가 그랬듯 여기서 멈춘다.

| 게이트 | 무엇이 막히나 | 실측 근거 |
|---|---|---|
| **코드사이닝 아이덴티티** (0개) | **iOS M2b 판정 불가.** (한때 "제품 결함"으로 승격했다가 **정정함** — 입력을 덮던 배너는 앱 UI가 아니라 개발 모드 LogBox였다, `.prd/09` §BB. 릴리즈에선 조용히 토큰이 안 나온다.) 엔타이틀먼트가 비어 키체인이 안 돌고 `expo-secure-store`가 아예 실행되지 않는다. iOS는 그 코드가 *실제로 필요한 유일한 플랫폼*인데(Android는 앱 삭제 시 secure-store가 원래 사라진다) 그 시험을 못 한다 | `.prd/09` §R. 재서명 우회 2회 실패(`containerization was prevented`) — 3회째 금지 |
| **Expo 계정 + EAS projectId** | **M5 푸시의 동작 경로 전체.** `getExpoPushTokenAsync`가 projectId 없이는 `ERR_NOTIFICATIONS_NO_EXPERIENCE_ID`로 던진다 | `npx expo whoami` = `Not logged in` · `eas.json` 부재 · `~/.expo/state.json`의 `auth` 없음 · 코드 경로 `use-blocked-push.ts:210-233` |

**M5의 절반은 이 게이트 없이도 닫힌다** — 푸시가 안 오는 것이 *보이게* 만드는 쪽(`app/settings.tsx`의
`NotificationsSection`이 `no-token`을 읽을 수 있는 문장으로 표시). 그게 이 기능에서 조용한 실패를
막는 유일한 표면이므로, 게이트 전에 QA할 값어치가 있는 것은 그 degraded 경로다.

---

## 다음 행동

**이 목록은 아직 안 한 것만 담는다.** 닫힌 것의 근거·잔여는 아래 §닫힌 것으로 내렸다 —
취소선 항목이 쌓이면 이 절이 "다음 행동"이기를 그만두기 때문이다.
(2026-08-23 재작성: 구 1·1b·2는 전부 닫혔다 — iOS M3 PASS §BB, `init()` 근인 수리 §Y, M4 Android PASS §Z.)

### N-A. ~~서버 작업 3건~~ — **전부 닫혔다 (2026-08-25 오후)**

1. ✅ **`remote.set_keybindings`** (`98b40b07`, set_auto_update 패턴 복제, nextest 4008) +
   폰 세그먼트 컨트롤 (`e7a30fba`, 목업 `:455-458` 그대로, 1035 tests). **한계 기록 = `.prd/09` §UU**:
   폰이 직접 다이얼한 박스(레지스트리에 자기 미등재)에는 `remote_not_found`일 수 있어 컨트롤이
   서버 판정 4상태를 그대로 표시하고 로컬 저장은 항상 살아남는다. nodes 행 확장 노출은 안 한다.
2. ✅ **`pane.list {recent_lines}` 배치** (`6b8c9846`) + 클라이언트 전환 (`848f5c37`) —
   요약줄이 목업 원의미(마지막 출력 줄)로 복귀, `terminal_title_stripped`는 구서버 폴백.
   결정 9 갱신됨. Agents 홈(`agent.list`)만 근사 잔존(`AgentInfo`에 recent 없음).
3. ✅ **TUI 호스트 메뉴 `show qr`** (`e559e7e9`) — 사이드바 호스트 메뉴 마지막 행, `herdr pair`와
   같은 발행 경로(`pairing_code_for`), 중앙 오버레이 dark-on-light 렌더, nextest 4019.
   **잔여**: 실서버에서 TUI로 띄워 폰 스캔까지의 실측은 안 했다(리시트는 렌더버퍼 단언까지).

부수: 게이트 정본이 이 날 확정됐다 — **nextest만**(`cargo test`는 하네스 오염 2종, §TT) +
**clippy는 툴체인 bin PATH 선두 고정**(Homebrew clippy 누수, `01-spec.md` 함정). 최종 리시트:
nextest 4019/4019 · clippy 0err · fmt clean · 모바일 1035 tests + typecheck/lint/format/bundle.

### N-QA. **재QA 라운드 — 최우선** (Android 8차 · iOS 12차, 각각 별도 에이전트)

**Android 8차 판정 도착 (2026-08-25, `.prd/09` §VV): 서체 1 FAIL / 4 PASS.** FAIL = 볼드 5곳
Roboto 폴백(합성/잔존 `fontWeight` 페어 — Android는 커스텀 패밀리 weight 합성이 없다).
2(클리핑)·3(요약줄 recent)·4(keybindings 세그)·5(회귀)는 PASS. 수리 유닛(fontWeight 전수 스윕 +
600 SemiBold 페이스 + 소스 스캔 discipline 테스트) 진행 → **Android 9차 표적 재QA 필요**.

대상(전부 08-25 오후 변경분):
1. **JetBrains Mono 실렌더** — iOS는 첫 실증(지금까지 산세리프였다), Android는
   Roboto Mono→JetBrains Mono 전환에 따른 **클리핑 회귀**(1·2차 QA가 잡던 클래스) 확인.
2. **pane 요약줄** — mock 경로에서 `mock-fixture` 접두 문자열이 요약줄에 뜨는 것(= recent 소비 증거),
   live 경로에서 실제 마지막 출력 줄.
3. **settings keybindings 세그먼트**(목업 #7 위치·반전 표현) + 값 변경 시 결과 줄 표시.
4. 기존 회귀 스윕은 `.prd/10` 절차대로 (고정 워크트리 + 플랫폼별 Metro 포트, iOS는 포트 결속 확증 §HH).

### N-B. 유저 게이트 3건 — 내가 못 넘는다

**iOS 코드사이닝 · iOS 실기기 · M5 Expo 계정.** 자격증명·하드웨어·계정이라 대신할 수 없다.
이 셋이 막고 있는 것: iOS M4(생존성, 시뮬로 안 닫힘) · iOS 조건 5의 **실제 QR 스캔** ·
M5 푸시 전체(앱·서버는 이미 배선됨).

구 "유저 판정 3건"(터미널 사이징 · pane 요약줄 소스 · 액세서리 키 19 vs 6)과 목업 #8은
**게이트를 잘못 세운 것이었다** — 판정 근거가 이미 레포 안에 있었다.
`06-open-decisions.md` 결정 8·9·10과 `11-mockup-conformance.md`에서 확정했고 전부 현 구현 유지다.

### N0. **목업 대조 — 최우선.** UI 정본을 8개 마일스톤 내내 안 읽었다 (2026-08-23 목표 조건 4)

**사고**: `.prd/assets/mockup.html`(7화면)이 UI 정본이고 `01-spec.md:52`가 그렇게 명시하는데,
구현·QA를 주도한 에이전트가 **한 번도 열지 않았다.** 목표 2번의 "orca mobile 와꾸를 이용"을
**orca 소스 포팅**으로만 읽고, 이 레포에 이미 있던 유저의 화면 설계를 건너뛰었다.
유저가 발견해 정정했고 **목표에 조건 4(모던 UI QA 필수)가 신설됐다.**

**기계적 원인**: `.prd/10`에서 "목업"이 **mock 데이터**만 뜻했다(6군데 전부). UI 정본은 0건.
같은 단어를 브리프에서 계속 보면서도 다른 것이라는 걸 확인하지 않았다.
→ **`.prd/10`에 §UI 대조 QA 신설** (화면 QA의 필수 절반, 판정 enum에 `초과` 포함, 용어 분리).

**감사 완료** (2026-08-23, 별도 에이전트). 전문 = **[`11-mockup-conformance.md`](11-mockup-conformance.md)**.
**누락 16 / 초과 10.** 요약:

| 등급 | 무엇이 막히나 |
|---|---|
| **P0** | **앱 단독으로 원격을 못 붙인다** — 프로브 라인·QR·FAB 부재. 지금은 settings 깊숙한 11필드 폼에 개인키를 폰에서 타이핑하고 도달 여부를 알 화면이 없다 |
| **P1** | **화면 간 이동이 막힌다** — back 브레드크럼 전무(④⑤⑥), 터미널 헤더의 노드명이 정상 경로에서 소실 |
| **P2** | **스캔 능력이 죽는다** — 목업이 acceptance로 못 박은 `└ pane.read` 요약줄 부재, 노드 dot 2종 고정 |
| **P3** | ④/⑤ 병합 구조, 경과시간(**서버 API 제약** — 별도 이슈), 표기 취향 |

`History` 버튼(초과)은 **제거가 아니라 유지** — 누락 #13과 같은 `pane.read` 소비자이므로
**요약줄을 추가해 대칭**을 맞춘다. 액세서리 키 19 vs 6은 `01-spec.md:55`가 미검증으로 표기한
영역이라 **유저 판정** 대상이다.

**끝나면**: 대조표 → 차이별 이슈화 → 목업이 acceptance인 재구현. **N1·N2보다 앞선다** —
제스처 지연을 고쳐도 화면이 설계와 다르면 목표 4가 안 닫힌다.

**진행 (2026-08-23~24)**: P1 #10·#15 · P0 #4 FAB · P2 #13 요약줄 · P0 #9 프로브 · 전면 모노스페이스 ·
P2 #3 섹션 · #5 dot 4종 · #6 `reconnecting… · last seen` · FAB 반전 · #14 blocked 반전 뱃지 ·
**agents 화면 위치 핸들** — 착지.

기기 UI QA **3회 완료**:
- **1차** — 팔레트는 정확한데 판정자가 "일반 Material 다크"로 읽었다. 원인은 색이 아니라 **서체**
  (목업 계약 `body { font-family: var(--mono) }`가 2개 컴포넌트에만 있었다) → 전면 모노 전환.
- **2차** — 타이포 목표 도달 확인. 동시에 **내 수리 2건이 방향 반대**임이 실측으로 드러났다
  (리포트 문장을 읽고 패딩을 줄였는데 요구는 오른쪽이었다 — 값은 화면 자신의 기하에서 유도해야 한다).
- **3차** — `└` 들여쓰기 · 칩 첫 슬롯 · settings 헤더 서체 **3건 PASS**. 헤더 우측 클리핑만 FAIL:
  중복 슬롯 제거는 실제로 됐는데 **잘리는 항목이 다음 것으로 옮겨갔을 뿐**(x=1079 세 라운드 동일).
  → 목업 06대로 상태 체인을 **터미널 아래 `agentline`으로 이동**(헤더에 남는 건 크럼·핸들·제목·History).
  **예산 초과한 행에서 항목 하나를 빼면 무엇이 잘리는지만 바뀐다** — 이게 3라운드의 교훈이다.
  ⚠️ 이 수리는 **기기 미검증** — 4차 1순위.

**남은 누락과 그 성격** (08-25 오후 갱신):
| # | 상태 |
|---|---|
| #1 QR · #2 수동추가 진입점 | 데스크톱 `show qr`이 **생겼다**(`e559e7e9`) — 남은 것은 실서버 실측뿐 |
| #7 keybindings | **닫힘** — 서버 `98b40b07` + 폰 `e7a30fba` (§N-A, 한계는 09 §UU) |
| #8 auto-update | **배선 안 함 확정** (2026-08-25, `11-mockup-conformance.md` — 같은 라벨 다른 동작) |
| #12 워크스페이스 `+` | **무엇을 만드는 버튼인지가 미정**. 동작 없는 `+`는 없느니만 못하다 |
| #13 요약줄 | **닫힘** — `6b8c9846`+`848f5c37`. 경과시간 표기만 #16으로 잔존 |
| #16 경과시간 | 서버 API에 타임스탬프가 없다 — 클라이언트로 안 닫힌다 |

### N1. ~~iOS M6a~~ — **닫혔다** (2026-08-24, 9차 기기 판정 PASS)

**수리는 네이티브가 아니었다.** 페이지가 모든 touchmove를 받고 `shouldYieldHorizontal`의 판별 창이
RN recognizer와 **같은 창**이므로, 포기(yield) 대신 **보고**하게 했다 — touchend에서
`{type:'pane-swipe'}`. 9차 실측: 글자 위 y=200/300/400 좌·우 **6/6 전환**, RNGH는 12회 내내 `dx=0`
(전환 주체가 페이지임이 그대로 갈린다), `touchend` 전제 성립(`[touchProbe]` 3종 12/12).
회귀 전부 PASS — **확대 상태 가로 팬에서 전환 0회**가 특히 중요하다(페이지가 가로를 되가져가는 분기).
아래 구 기록은 소진된 경로의 근거로 남긴다.

### ~~N1(구)~~. iOS M6a — 네이티브 recognizer 중재

**JS는 소진됐다** (§OO). 7라운드가 남긴 확정 사실만 옮긴다:

- 글자 위 드래그: WebView 문서가 `touchmove` **40개를 전부 받고**, RN pan은 **0개** → `dx=0`.
- 마지막 도색 행 **아래 공백**에서 시작한 같은 드래그: WebView 이벤트 **0건**, RN이 `dx=−295`,
  **전환·양 끝 no-op·재연결 0까지 전부 정상 동작**.
- 경계는 `#terminal-surface`(`display: inline-block`)의 끝. 즉 **WKWebView가 경합에 참여하는 영역**과 같다.
- `passive: true`·`touch-action: none`·`preventDefault` 제거는 **전부 적용됐고 이 결과를 안 바꿨다**
  — `passive`는 `preventDefault`만 없앨 뿐 **UIKit 제스처 중재의 승패를 바꾸지 않는다.**

**따라서 수리 지점은 네이티브다.** 후보 2종:

1. ~~**RNGH 쪽**~~ — **소진됐다**(§QQ→§RR). `Gesture.Native()`로 ref 문제를 우회해
   `blocksExternalGesture`를 실제로 배선했고(서빙 번들에서 7회 확인), **`dx`는 0에서 안 움직였다.**
   되돌렸다. **이 경로를 다시 시도하지 마라.**
2. **WKWebView 쪽** — `webView.scrollView.panGestureRecognizer`에 대해 RNGH의 pan을
   `require(toFail:)` 시키거나 `shouldRecognizeSimultaneouslyWith`를 열어준다.
   `scrollEnabled={false}`여도 recognizer 객체는 살아 있다(`TerminalWebView.tsx:428`).

**수용 기준**: 글자 위 y=200/300/400에서 `[paneSwipe] finalize`의 `dx ≠ 0`.
계측은 이미 앱에 있다(`[paneSwipe]` + `[touchProbe]`, §JJ/§LL) — **판별표까지 §OO에 있으니 재발명 금지.**
회귀 확인 필수: 선택 진입·핸들 드래그 / 핀치 / 줌 상태 팬 (7차에 전부 PASS로 실측된 기준선).

### N2. ~~pane 전환 문서 재빌드~~ — **닫혔다** (2026-08-24, 양 플랫폼 기기 판정 PASS)

Android 4차: **백지 0ms**(4회 전부), 깊은 버퍼(836행) 복귀도 0ms — 전에는 백지 3s / 내용 15s였다.
문서 동일성은 CDP 타깃 id 불변 + JS 전역 마커(`window.__qaDocId`, 재생성 시 소멸) 생존으로 직접 증명.
iOS 9차: 전환 중앙값 **≈288ms**(상한), 프레임 레벨 55~68ms — 전 상태 재빌드 523~731ms.
아래 구 기록은 원인 분석의 근거로 남긴다.

### ~~N2(구)~~. pane 전환 문서 재빌드

pane을 바꿀 때마다 **730KB xterm 문서가 통째로 재생성된다**(§CC에서 CDP 타깃 id로 확증, 칩 탭도 동일).

| 플랫폼 | 스와이프/탭분 | 문서 재빌드분 |
|---|---|---|
| Android (§FF) | **184ms** | 나머지 ~530ms, 278줄 버퍼 pane 복귀 시 **+3s 백지 / +15s 내용** |
| iOS (§OO) | **≈ 0** | **523~731ms** (중앙값 715), 읽을 수 있는 새 pane까지 총 ~0.9–1.0s |

iOS 한 케이스에서 `[fit]renderer`가 관측 헤더 커밋보다 **먼저** 왔다 = 가시 지연 전체가 재빌드 지배.
**M6a의 `<200ms` 예산은 제스처가 아니라 여기서 깨진다.** 수리 방향은 pane별 문서를 **재사용**하는 것
(리타겟은 이미 §2.3대로 같은 채널에서 일어난다 — 문서만 버려지고 있다).

**원인 확정 + 수리 (2026-08-24, `PaneViewerRoute`)**: 재빌드의 원인은 터미널 컴포넌트가 아니라
**라우팅 한 줄**이었다. `[paneId]`가 동적 세그먼트라 `router.replace(paneHref(...))`는 *다른 라우트*이고,
expo-router가 화면을 언마운트하면서 문서가 같이 죽는다. `TerminalPaneView`/`TerminalWebView`엔
handle 기반 `key`가 없어(`src/session/TerminalPaneView.tsx`) 컴포넌트 인스턴스만 살면 문서는 산다.
→ `router.setParams({ paneId })`. URL은 그대로 pane을 가리키므로 Back·딥링크·알림 탭
(`src/notifications/pane-deep-link.ts`)의 복원 경로가 불변이다.

**게이트**: `pane-viewer-mount.test.tsx`에 ①`replaced`가 비어 있고 `paramsSet`만 찍힐 것
②pane 전환 전후로 **WebView 마운트 카운트 1**. ②만으론 부족하다 — 렌더 트리는 "같은 문서를 리타겟한
것"과 "똑같이 생긴 새 문서"를 구별하지 못해서 마운트를 센다. ①이 라우트 정체성 변경을 잡는 절반이다.
`pane-swipe-mount.test.tsx` 4건도 같은 계약으로 갱신.

**⚠️ 기기 미검증**: 실제 지연 감소(iOS 523~731ms → ?)는 아직 안 쟀다. 다음 기기 QA 라운드의 1순위.

### N3. 유저 게이트 3건 — 내가 못 넘는다

| 항목 | 필요한 것 |
|---|---|
| iOS M2b | 코드 서명 identity (계정 액션) |
| iOS M4 | **실기기** — 기내모드·Wi-Fi↔셀룰러는 시뮬레이터로 재현 불가 |
| M5 센더 데몬 | Expo 계정 로그인 (`npx expo whoami` = Not logged in) |

게이트 전에 닫을 수 있는 것은 M5의 degraded 경로 QA뿐이다(설정 화면이 `no-token`을 읽히는 문장으로 표시).

### N4. ~~서버 위생 1건~~ — **닫혔다 + 같은 클래스 2건 추가 발견 (2026-08-25)**

`pane.read`의 `strip_ansi`는 **제거됐다**(`240019fd`) — `read_terminal_snapshot`의 분기는
`(format, source)` 하나뿐이라 `strip_ansi`가 표현할 상태를 `format`(Text/Ansi)이 전부 표현한다
(완전 중복; 배선하면 "format=text인데 본문은 ANSI"인 자기모순이 표현 가능해진다).
`deny_unknown_fields` 부재로 구 클라이언트의 `strip_ansi` 송신은 종전과 동일하게 무시된다(테스트 고정).

**같은 클래스 잔여 2건 — 역시 닫혔다** (`347cfd64`, nextest 4025):
`AgentReadParams.strip_ansi` · `PaneWaitForOutputParams.strip_ansi`(+`Subscription::PaneOutputMatched`)
제거, back-compat 무시 테스트 3건. `pane wait-output --raw`는 usage에서 빼되 인자로는 수용(no-op —
삭제하면 구 스크립트가 죽는다). 모바일 stale 주석도 갱신(`8cb18d43`). strip_ansi는 API 전체에서 소멸.

**병렬 금지 아님**: N1·N2·N4는 서로 독립이다. per-unit dispatch(rules/DEV.md §3) 유지 —
**단, QA는 각자 고정 워크트리 + 각자 Metro 포트를 받는다**(§QA 게이트). 두 QA가 `app.json` 하나를
공유하면 고정이 무의미해지고, iOS는 **포트 결속을 앱에서 확증**해야 한다(§HH — 6회 연속 깨졌다).

---

## 닫힌 것 — 근거와 잔여 (여기는 읽을 때만 본다)

**M-1 · M0 · M1** — 상태표 참조.

**Xcode / ssh 라이브러리 핀** — Xcode 26.6 설치 완료. 결정 7 확정: `orlandos-nl/Citadel`
`exactVersion 0.12.1` (`ae8562f8`) + `Wellz26/swift-nio-ssh` **revision** `a05e6bb`.
`npm run typecheck:ios`가 실제로 그 조합을 컴파일한다(exit 0).

> **iOS는 사실상 ed25519 전용이다** — Citadel `OpenSSHKey.swift:307-313`이 `BEGIN OPENSSH PRIVATE KEY`
> 컨테이너만 받고, 파싱을 통과한 RSA도 서명에서 죽는다(`rsa-sha2`가 Citadel 0.12.1·nio-ssh 0.3.6에 **0회**,
> 서명 프리픽스 `ssh-rsa` 하드코딩 — OpenSSH 8.8이 SHA-1 RSA를 껐다). Android가 `loadKeys` 포맷 판별로
> 고전 PEM RSA까지 받는 것과 **정확히 반대 방향의 제약**이다.
> **유저 키 실측**: `~/.ssh/*.pub` 8개 중 7개가 `ssh-ed25519`, 주력 2개가 openssh-key-v1 ed25519
> → **실사용 지장 없다.** RSA 1건(`perplay-vm_key`)만 iOS에서 못 쓴다. 차단 아님, 문서화 대상.

**M2 Android** — ✅ 5/5. (e)는 `284c0558` 수리 후 별도 에이전트 재판정 PASS.
**잔여(§P)**: 213컬럼 중 마지막 7~9열이 어떤 배율에서도 도달 불가. **§P의 진단이 맞는지 자체가
`.xterm-rows` 한 줄에 걸려 있다** — `.prd/09` §P의 갈림 표 참조. §U 수리 에이전트가 그 값을 측정한다.

**M2b 원격 설정 + 키 보관** — ✅ 코드 `c22d26ae`, Android QA PASS 3/3.
구현자가 "유닛 불가"로 넘긴 항목이 **sshd 로그로 닫혔다** — `Accepted publickey … ED25519 SHA256:M3qh…`가
일회용 키 지문과 일치.
**잔여(사용성)**: 키 필드를 탭해도 폼이 키보드 위로 자동 스크롤하지 않는다.
**미검증**: 실제 클립보드 붙여넣기, 릴리즈 빌드의 `__DEV__=false` 경로.
**iOS는 판정 불가** — 서명 게이트(위 §유저 게이트).

> 릴리즈 빌드에서는 원격을 바꾸려면 `app.json`을 고치고 재빌드해야 하고 개인키가 번들에 구워진다.
> **dev-client 디버그 빌드는 다르다** — `app.json` 편집 + Metro 리로드로 바뀐다(QA가 APK mtime 불변으로
> 실증). `cf9c5398` 커밋 메시지가 이 구분 없이 "재빌드해야 한다"고 쓴 것은 틀렸다.

**M3 입력** — ✅ PASS 4/4 (별도 에이전트, `qa-m3` 고정 워크트리). 액세서리 키를 **바이트 단위**로 판정:
`1b 09 0d 20 1b5b43 03 04 0c 1a 1b5b44 1b5b41`. Ctrl-C가 `sleep 300`을 실제로 죽이는 것까지.
PTY 39×93 불변, `resize` 이벤트 0건. **여기서 §Q가 나왔고** `d60afe9f`가 수리했다(검증은 M4 QA에 걸려 있다).

**M4 코드** — ssh redial `845f0f22` (①채널 개설 거부 즉시 ②`Welcome` 미도달 3연속, 타이머 없이 L3 사다리
속도). exec 데드라인 `b411ef04` (§S). §L1의 나머지 절반(마운트 시 실패한 원격이 앱 수명 내내 죽어 있던 것)은
`8f794748`이 다이얼 층에 재시도 루프를 놓아 닫았다 — `app-connections.ts:334`에서 배선 확인.
**잔여**: 없음. 단 exec 타임아웃이 "채널 개설 거부"로 오분류돼 레이트리밋을 우회한다 — 선재 결함이고
회귀가 아니라서 M4의 PASS를 churn하지 않기로 했다(§EE).

**M5 서버·앱** — 훅·센더·리시트 1472줄이 `81207036`에 착륙했는데 **어떤 게이트도 실행하지 않았다**
(`grep -rn blocked-push` 플러그인 밖 0건). `9210e99d`가 22테스트를 `just ci`에 배선.
`158e36f3`이 `app.json` 플러그인 배선 + 매니페스트를 `BLOCKED_CHANNEL_ID`에 묶는 테스트.
P2 coalesce는 **센더 몫으로 확정** — 봉투에 이전 상태가 없어 훅이 물리적으로 못 한다.

---

## QA 게이트 — 자기 인증 금지

> **QA 완료 판정은 반드시 별도 에이전트가 내린다** (2026-08-23 유저 지시).
> 구현한 에이전트도, 디스패처도 자기 작업의 QA를 통과시킬 수 없다.

절차 = [`10-mobile-qa.md`](./10-mobile-qa.md). 디스패처가 하는 일은 **QA 에이전트를 띄우고 그 판정을
받는 것**이지 판정 자체가 아니다. QA 에이전트는:

- 구현 에이전트와 **다른 디스패치**여야 한다
- `.prd/10`의 보고 형식 5항목을 채운다 (APK 시각+커밋 / 스크린샷과 읽은 내용 / mock·live 판정 근거 /
  열어본 화면 / 못 한 것)
- **PASS / FAIL을 명시**한다. "문제 없어 보임"은 판정이 아니다

FAIL이면 그 마일스톤은 안 닫힌다. 재구현 후 **다시 별도 에이전트**에게 보낸다.

---

> ⚠️ **이 표를 믿기 전에 확인하라.** 2026-08-23에 이 표가 M5를 "미착수"로 적고 있었는데 실제로는
> 1472줄이 이미 착륙해 있었다. 코드 존재 여부는 `git log`/`grep`으로, **게이트가 그걸 실행하는지는
> `justfile`/`ci.yml` 참조로** 따로 확인하라 — 이 레포에서 둘은 자주 어긋난다.

## 작업 종료 시 할 일 (이 파일의 수명 유지)

1. 위 상태 표 갱신 — 근거 커밋/스크린샷을 함께
2. "다음 행동" 재정렬
3. 새로 드러난 결함은 [`09-review-followups.md`](./09-review-followups.md)에 append
4. 계획 자체가 틀렸으면 **해당 문서를 고친다** — 드라이버에 예외를 쌓지 말고

---

## 문서 지도

| | |
|---|---|
| [`01-spec.md`](./01-spec.md) | 무엇을 만드는가 · 작업 환경 함정 |
| [`02-architecture.md`](./02-architecture.md) | 2채널 구조, 계층 |
| [`03-blockers.md`](./03-blockers.md) | B1~B10 — 왜 어떤 것이 불가능한가 |
| [`04-milestones.md`](./04-milestones.md) | M-1~M6 정의와 수용 기준 |
| [`05-orca-transport.md`](./05-orca-transport.md) | 생존성 L1~L6 (orca 이식) |
| [`06-open-decisions.md`](./06-open-decisions.md) | 미결 결정 + 실기기 검증 결과 |
| [`07-research-2026-08-22.md`](./07-research-2026-08-22.md) | 배포 채널·존재 조건 리서치 |
| [`08-orca-port-map.md`](./08-orca-port-map.md) | **와꾸 SSOT** — 모르면 여기서 orca의 결정을 본다 |
| [`09-review-followups.md`](./09-review-followups.md) | 리뷰 지적과 그 처리 원장 |
| [`10-mobile-qa.md`](./10-mobile-qa.md) | QA 절차 (판정은 별도 에이전트) |
