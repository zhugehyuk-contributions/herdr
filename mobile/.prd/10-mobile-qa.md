# 10 — 모바일 앱 QA

> **상시 규율 (2026-08-23 유저 지시).** 모바일 앱 코드가 바뀌면 **빌드로 끝내지 않는다 — QA까지가 한 단위다.**
> "컴파일된다"·"테스트 green"은 앱이 동작한다는 증거가 아니다. 이 문서의 절차를 돌려 **화면을 실제로 본 것**이
> 산출물이며, 보지 않았으면 미완이라고 보고한다.

`mobile/**`·`packages/herdr-client-ts/**`·`modules/herdr-ssh/**` 중 무엇이든 손대면 발동한다.

## ⛔ 자기 인증 금지 — 판정자는 별도 에이전트다

> **QA 완료 판정은 반드시 별도 에이전트가 내린다** (2026-08-23 유저 지시).

구현한 에이전트가 자기 작업을 통과시킬 수 없고, 디스패처도 마찬가지다. 디스패처가 하는 일은
**QA 에이전트를 띄우고 그 판정을 받는 것**이지 판정이 아니다.

- QA 에이전트는 구현과 **다른 디스패치**여야 한다 (rules/DEV.md §2 위임 우선의 QA판)
- 판정은 **PASS 또는 FAIL**로 명시한다. "문제 없어 보임"·"정상 동작 확인"은 판정이 아니다
- FAIL이면 그 마일스톤은 닫히지 않는다. 재구현 후 **다시 별도 에이전트**에게 보낸다
- 판정 근거는 아래 §보고 형식 5항목 — 하나라도 비면 판정 무효

**왜 이 규칙이 있나**: 자기 작업물의 QA는 "무엇을 봐야 하는지"를 구현자가 이미 정해버린 상태에서
돌아간다. 이 세션에서만도 `onClose`만 가드하고 `onMessage`를 놓친 것을 외부 리뷰가 잡았고
(`.prd/09` §O), 목업 판별자를 반쪽만 기억하고 있던 것도 실측에서 드러났다.

---

## ⛔ UI 대조 QA — 화면 QA의 **필수 절반** (2026-08-23, 목표 조건 4 신설)

**모든 화면 QA는 기능 판정과 UI 대조 판정을 **둘 다** 낸다. 하나만 있으면 그 QA는 무효다.**

### 정본

`.prd/assets/mockup.html` — **7화면**. `.prd/01-spec.md:52`가 *"UI 목업 7화면 + 계획 요약.
발행된 아티팩트의 소스"*라고 명시하고 발행 URL까지 달아놨다.
(`assets/mockup-v5-original.html`은 v0.6.8 기준 초판 — 화면 설계 참고용, 충돌 시 `mockup.html`이 이긴다.)

**목업 화면 아래 붙은 설명 텍스트가 acceptance 문장이다.** 예:
*"tab은 섹션 헤더, 행 = pane"* · *"pane id = herdr 표기 그대로 (`1-1`, `1-2` …)"* ·
*"카운트는 pane 기준"* · *"요약 줄 = `pane.read`"*. 그림만 보고 문장을 빼먹지 마라.

### ⚠️ 이 문서에서 "목업"은 두 가지를 뜻한다 — 그 충돌이 사고를 만들었다

| 뜻 | 어디서 쓰이나 |
|---|---|
| **mock 데이터** (실서버 아닌 픽스처) | 아래 §Mock / Live 판별. 이 문서의 기존 용례 **전부** |
| **UI 설계 정본** (`assets/mockup.html`) | **이 절. 2026-08-23 이전엔 이 문서에 한 번도 안 나왔다** |

2026-08-23까지 구현·QA를 주도한 에이전트는 브리프에서 "목업"을 mock-데이터 판별 문맥으로만 만났고,
**같은 단어의 UI 정본을 8개 마일스톤 내내 한 번도 열지 않았다.** 유저가 발견해 정정했다.
**혼동을 피하려면**: mock 데이터는 "**mock 픽스처**", UI 정본은 "**목업 화면**"이라고 부른다.

### 판정 방법

1. 브리프가 **어느 목업 화면**과 대조하는지 번호로 지정한다. 지정 없는 화면 QA는 무효다.
2. 판정자는 **스크린샷 ↔ 목업 화면**을 **요소 단위**로 대조한다 — 라벨 문구, 배치, 상태 표기,
   카운트의 분해 방식(예: `2 working · 1 blocked` vs `3 unknown`), 계층(섹션 헤더 vs 평면 목록).
3. 판정 enum: `일치` / `차이-배치` / `차이-내용` / `누락` / **`초과`(구현에 있는데 목업에 없음)** / `판정 불가`.
   **`초과`를 반드시 잡아라** — 구현자가 설계한 UI가 목업을 대체해 버리는 것이 이 사고의 형태였다.
4. **폴백과 설계 차이를 구분한다.** 예: pane이 이름 없으면 `1-1` 대신 id로 폴백하는 것이
   `src/session/pane-chips.ts:43`에 있다. 랩 픽스처가 이름을 안 붙여서 생긴 차이는 `일치`다.
   → **UI 대조용 픽스처는 목업 화면이 보여주는 상태(이름 있는 pane, working/blocked 섞임)를 만들어야 한다.**

### 보고 계약

기능 판정 블록과 별도로 이 줄을 낸다:

```
UI 대조 (목업 화면 <N>): <일치 | 차이 N건 | 판정 불가>
  차이: <요소 — 목업이 요구하는 것 / 구현이 하는 것 / enum>
  초과: <목업에 없는데 구현에 있는 것>
```

---

## 왜 유닛 테스트로 부족한가

이 앱에서 **컴파일도 유닛 테스트도 잡지 못하는 결함 등급**이 실측으로 확인됐다:

- `.prd/06:165` — Expo 모듈 등록 실패(`Class()`에 `Constructor` 필수). `:herdr-ssh:assembleDebug` green + 스텁 타입체크 green인데 **Expo 빌더가 등록 시점에 던진다.** 실행이 아니면 못 잡는다.
- `.prd/09` §G — 스냅샷이 마운트 시점에 얼어붙던 문제. 화면을 30초 이상 **보고 있어야** 드러난다.
- `.prd/09` §M — 인증 실패가 `transport`로 오분류되어 영구 재시도. 실패 경로는 성공 경로 테스트가 건드리지 않는다.

즉 QA는 "혹시 모르니 한 번 더"가 아니라 **다른 결함 등급을 담당하는 별개의 게이트**다.

---

## 판독 방법 — 실측으로 확정 (2026-08-23)

가장 먼저 정한 것은 "에이전트가 화면을 어떻게 읽는가"다. 두 후보를 실제로 돌려봤다:

| 방법 | 결과 |
|---|---|
| `uiautomator dump` → 텍스트 추출 | **앱 화면에서 텍스트 노드 0개** ❌ |
| `adb exec-out screencap -p` → 이미지 판독 | **동작** ✅ |

**RN 신아키텍처(Fabric)는 접근성 트리에 텍스트를 올리지 않는다.** `accessibilityLabel`이 소스에 77개 있는데도 그렇다.
헷갈리기 쉬운 함정이 하나 있다: **expo-dev-client 런처 화면은 `uiautomator`로 읽힌다**(네이티브 화면이므로).
그래서 런처에서 덤프해보고 "텍스트 판독이 된다"고 결론내면 틀린다 — 앱 본체로 들어간 뒤 다시 확인해야 한다.

→ **화면 판독은 스크린샷 + 비전이 정본이다.** `uiautomator`는 런처 조작(좌표 확보)에만 쓴다.

미검증 대안: **Maestro**(RN Fabric 지원이 낫다고 알려짐)는 설치해보지 않았다. 스크린샷 판독이 병목이 되면 그때 평가한다.

---

## 환경

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

`java`·`adb`·`emulator`는 기본 PATH에 **없다**. AVD는 `herdr-test` 하나가 이미 있다.

---

## 절차

### 0. 에뮬레이터

```bash
emulator -avd herdr-test -no-snapshot-load -no-audio -gpu swiftshader_indirect &
# 부팅 완료 = adb shell getprop sys.boot_completed 가 1
```

### 1. 빌드 — 반드시 현재 코드로

```bash
cd mobile/android && echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew :app:assembleDebug --console=plain
```

**빌드 산출물의 시각을 확인하라.** `app-debug.apk`가 마지막 커밋보다 오래됐으면 그건 다른 코드다.
2026-08-23에 실제로 이 함정을 밟았다 — 21:02 APK를 그대로 설치할 뻔했고, 그 사이 착륙한 Kotlin
`finish()` 재작성(네이티브!)이 전부 빠져 있었다. `stat -f "%Sm" apk` 1줄이면 막힌다.

### 2. Metro + 설치

디버그 APK는 JS를 번들에 안 담고 Metro에서 받아온다. **Metro 없이는 앱이 안 뜬다.**

```bash
cd mobile && npx expo start --port 8081 &
curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/status   # 200 확인
adb reverse tcp:8081 tcp:8081
adb install -r -d android/app/build/outputs/apk/debug/app-debug.apk
```

### 3. 실행 — 런처를 통과해야 한다

```bash
adb shell am start -n dev.herdr.mobile/.MainActivity
```

이러면 앱이 아니라 **expo-dev-client 런처**가 뜬다. `DEVELOPMENT SERVERS` 아래 `http://10.0.2.2:8081`을
눌러야 앱이 로드된다. 이 화면은 `uiautomator`로 읽히므로 좌표를 뽑을 수 있다:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml
# bounds="[x1,y1][x2,y2]" 에서 중심 좌표 → adb shell input tap <x> <y>
```

번들링은 Metro 로그로 확인한다 (`Bundled … (3184 modules)`).

### 4. 판독

```bash
adb exec-out screencap -p > /tmp/app.png     # 그리고 이미지를 직접 본다
```

---

## ⚠️ 새 QA 워크트리에는 생성물이 없다 (2026-08-23 실측)

QA 전용 워크트리(§자기 인증 금지의 durable fix)를 쓰면 **gitignore된 생성물이 전부 빠져 있다.**
M3 QA가 두 번 밟았다:

1. **`mobile/android/`가 없다** — Expo prebuild 산출물이라 gitignore. `npx expo prebuild -p android`
   후에야 `:app:assembleDebug`가 가능하다.
2. **`mobile/src/terminal/terminal-webview-engine.generated.ts`가 없다** — `postinstall`이 만드는
   gitignored 생성물. 없으면 **Metro 500 → 앱 크래시**. `node scripts/build-terminal-webview-engine.mjs`.
3. **랩 herdr을 워크트리에서 빌드해야 한다** — `~/.local/bin/herdr`(0.8.0-mx)는 `PROTOCOL_VERSION 21` /
   `WIRE_ABI_EPOCH 3` **이전**이라 앱이 못 붙는다. `ZIG=/opt/homebrew/opt/zig@0.15/bin/zig cargo build --bin herdr`.

그리고 **Metro는 반드시 자기 워크트리에서, 다른 포트로** 띄운다(M3 QA는 8082). 안 그러면 격리의 의미가
사라진다 — 다른 트리의 코드를 QA하게 된다. `adb reverse` 없이 `10.0.2.2:<포트>` 직결이면 혼선 불가능.

---

## 라이브 랩 재구축 (실측 절차, 2026-08-23)

QA 사이에 랩이 죽어 있다(sshd·tmux 종료, `app.json` 원복). 매번 다시 세워야 한다:

1. throwaway ed25519 키 2쌍 생성 (호스트키 + 유저키). **유저의 실제 키 금지.**
2. `/usr/sbin/sshd -f /tmp/<lab>/sshd_config` — 에뮬레이터에서 `10.0.2.2:<port>`로 보인다
3. `tmux -L <lab> new-session -x 240 -y 52` 안에서 herdr 클라이언트 기동
   > ⚠️ **`HERDR_ENV`·`HERDR_SESSION`·**`HERDR_SOCKET_PATH`** 등 herdr env를 반드시 unset하라.** 안 하면
   > *"nested herdr is disabled"*로 즉사한다. (같은 계열 함정이 Rust 게이트에도 있다 — `.prd/01`)
4. `app.json`의 `extra.herdrRemotes`에 랩 원격 주입. **Metro 재시작 불필요** — 매니페스트를 요청 시
   재읽는다(실측 확인).

## WebView 조작 — CDP

`uiautomator`가 앱 화면을 못 읽으므로 터미널 내부를 다루려면 CDP를 쓴다.

- **소켓 이름이 문서 기본값과 다르다**: `chrome_devtools_remote`가 **아니라**
  `webview_devtools_remote_<pid>` 형태다. 찾는 법:
  `adb shell cat /proc/net/unix | grep devtools` → `adb forward tcp:9222 localabstract:<그 이름>`
- **핀치 주입 좌표 함정**: 축소 상태에서 `#terminal-surface`의 히트 박스는 **뷰포트 상단 약 196 CSS px뿐**이다.
  그 아래를 찍으면 이벤트는 전송되지만 리스너 없는 `#terminal-container`에 맞아 **조용히 무시된다.**
- 도달 확인은 document capture 카운터(touchstart/move/end)로.

## 기계적 판정자 — 눈보다 강하다

"온전해 보임"은 판정이 아니다. 터미널 상태는 다음 두 값으로 **수치 판정**할 수 있다:

| 무엇을 보나 | 어디서 |
|---|---|
| 그리드 붕괴 여부 | `.xterm`의 `offsetWidth`/`offsetHeight` — 서버 지오메트리가 안 바뀌면 불변이어야 한다 |
| 줌 유지 여부 | `#terminal-surface`의 `style.transform` — 프레임 도착 전후로 같아야 한다 |

2026-08-23 (e) 재판정이 이 두 값으로 `1630×777` 불변과 `scale(2)` 유지를 증명했다.

---

## Mock / Live 판별 — 이걸 틀리면 QA 전체가 무효다

> ⚠️ **여기서 "목업"은 mock 데이터 픽스처를 뜻한다** — UI 설계 정본(`assets/mockup.html`)이 아니다.
> 둘을 가르는 규칙은 위 §UI 대조 QA에 있다.

앱은 원격이 하나도 설정되지 않으면 **픽스처를 렌더한다**(커밋 `2a2c8a3b`: 미설정 → fixture,
다이얼 중 → loading, 설정됐는데 전부 실패 → error). 픽스처가 진짜처럼 생겼기 때문에 **"화면이 그려졌다"를
"동작한다"로 읽는 것이 이 앱의 대표적 오판**이다.

**폐기된 판별자**: "목업은 4 nodes / 40 agents 고정" — **틀렸다.** 2026-08-23 실측 화면은
`4 nodes` / `8 blocked · 16 working` = 24 agents였다. 노드 수만 맞고 에이전트 수는 안 맞는다.

**정본 판별자** — `src/api/mock/mock-fixture.ts`의 고유 문자열:

| 화면에 이게 보이면 | 판정 |
|---|---|
| `reviewing PR #91` · `writing mockup html` | **목업** |
| 호스트가 `fable-m5max`·`iq-64`·`work-m16`·`blade-4090` 4종뿐 | **목업** (픽스처 호스트명이 실제 기기명이라 특히 헷갈린다) |

> ⚠️ **`fable-m5max`는 위양성이 난다 (2026-08-23 실측).** 그건 **이 맥의 실제 hostname**이라, 랩을 여기서
> 돌리면 터미널 프롬프트에 진짜로 찍힌다. 호스트명 하나만으로 "목업"이라고 판정하지 마라 —
> **난수 토큰이 정본 판별자다.**
| `app.json`의 `extra.herdrRemotes` 가 `[]` | **목업일 수밖에 없음** — 화면 보기 전에 확인 |

라이브를 봐야 하는 QA라면 **격리 스크래치 서버**를 띄우고 거기에만 붙인다.
`.prd/09` §G의 `ZQ7-LIVE-PROOF` 패턴처럼 **화면에서만 나올 수 있는 고유 문자열을 서버에 심어놓고**
그게 렌더되는지 보는 것이 위조 불가능한 증거다.

> ⛔ **에뮬레이터에 유저의 실제 ssh 키·실제 호스트를 넣지 않는다.** 스크래치 서버 + 일회용 키만.
> ⛔ `pkill -f herdr` 계열 금지 — 같은 바이너리 이름이라 유저 프로덕션 데몬을 같이 죽인다. PID로만.

---

## ⚠️ QA 창 동안 대상 트리를 얼려라

2026-08-23 실측: M2 (c)의 30분 관측 도중 `845f0f22`가 `mobile/src/transport/*`에 착륙했고, 앱이 Metro 위에서
돌고 있었으므로 **Fast Refresh가 관측 구간에 일부 적용됐다.** 그 판정((c)(d)(b))은 무관한 파일이라 살았지만,
운이 좋았던 것이지 절차가 막은 게 아니다.

> **규칙으로 두 번 실패했다 — 이제 기계로 막는다.** 2026-08-23에 두 번 다 디스패처(나)가 어겼다:
> (e) 재판정 창에 `845f0f22`가, M2b 창에 커밋 4개가 착륙했다. 두 번 다 "무관한 파일이라 살아났다"였고
> 그건 절차가 아니라 운이다. 원인은 명확하다 — **디스패처가 처리량을 위해 구현과 QA를 병렬로 굴리는 한,
> 공유 트리를 얼려달라는 부탁은 지켜지지 않는다.**
>
> **durable fix: QA는 자기 워크트리를 받는다.** 디스패처가 QA를 띄우기 전에 대상 커밋에 고정된
> 워크트리를 만들고(rules/DEV.md §1 규약 위치), QA 에이전트는 거기서만 돈다:
>
> ```bash
> git worktree add .worktrees/qa-<milestone> <commit-under-test> --detach
> ```
>
> 그러면 메인 트리에서 구현이 계속 돌아도 QA가 보는 코드는 움직이지 않는다. QA 종료 시
> `git worktree remove`. **판정 대상 커밋이 브리프와 워크트리에 둘 다 박히므로** "무엇을 QA했는가"가
> 사후에 흔들리지 않는다.
>
> 대가 하나는 남는다: 이 방식이어도 QA가 **수리 전 빌드에서 FAIL을 재현**하려면 부모 커밋 워크트리가
> 하나 더 필요하다. 대조가 필요하면 두 개를 만들어라.

구현 에이전트를 굴리고 있으면 QA 시작 전에 그 사실을 QA 에이전트에게 알리고, 겹치면 QA를 뒤로 미룬다.

---

---

## iOS 절차 — Android와 판독 방향이 **반대**다 (2026-08-23 신설)

위의 §절차는 전부 Android다. iOS 첫 QA(`.prd/09` §R)는 절차 없이 즉흥으로 돌았고, 그래서 재현이 안 됐다.
여기가 그 절차다. **Android 절차를 읽고 iOS에 옮겨 적용하지 마라 — 아래 세 지점이 정반대다.**

| | Android | iOS |
|---|---|---|
| 화면 판독 | `uiautomator` 텍스트 노드 **0개** → 스크린샷+비전 | 접근성 트리에 텍스트가 **올라온다** → **XCUITest `debugDescription`이 정본** |
| 랩 서버 주소 | 에뮬레이터에서 `10.0.2.2:<port>` | 시뮬레이터는 호스트 네트워크 스택을 공유 → **`127.0.0.1:<port>` 직결** (§R의 `ssh ed25519 인증 OK`가 이 경로로 성립한 실측) |
| 키 포맷 | `loadKeys` 판별로 고전 PEM RSA까지 | **사실상 ed25519 전용** — Citadel이 `BEGIN OPENSSH PRIVATE KEY`만 받고, RSA는 파싱을 통과해도 서명에서 죽는다 |

### ⛔ iOS 리그는 "install + Metro"로 완성되지 않는다 (2026-08-23, 실제 발동)

**앱이 어느 Metro에 붙었는지는 dev-launcher의 "최근 접속" 목록이 정한다** — 네가 방금 띄운 포트가
아니라, **이전 QA가 남긴 포트**가 최신값이면 그쪽 JS가 로드된다. 2026-08-23 iOS M6a QA에서 실제로
그랬다: 리그는 8086으로 세웠는데 앱은 **8081(`qa-ios-m2b`, 커밋 `105a2ea5`)** 을 물고 있었다.
판정자가 시작하자마자 잡아내 고쳤기에 망정이지, 그대로였으면 **다른 커밋을 판정한 리포트**가 나왔다.

- 셋업의 마지막 단계는 **"앱이 그 포트에 붙었음의 확증"** 이다. dev-launcher의 URL 표시, 또는
  대상 Metro 로그에 그 기기의 번들 요청이 찍히는지로 확인한다.
- `simctl openurl` 딥링크는 **SpringBoard 확인창에 막힌다** — 무인 경로가 아니다.
- **통하는 방법 (2026-08-23 2차에서 실증)**:
  `xcrun simctl openurl <UDID> "herdr://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A<PORT>"`.
  앱이 이미 포그라운드면 SpringBoard 확인창도 안 뜬다.
- **안 통하는 방법 2종** (둘 다 실측): `simctl spawn <UDID> defaults write`는 앱 컨테이너가 아니라
  **디바이스 전역** plist에 쓴다. 컨테이너 plist의 `expo.devlauncher.recentlyopenedapps`를 올바르게
  재작성해도(binary plistlib + cfprefsd kill) 앱은 이전 포트에 남는다 — 그 키는 자동 재결속 레버가 아니다.
  (1차 QA는 plist 재작성이 통했다고 보고했으나 2차에서 재현되지 않았다.)
- Android의 `adb reverse`는 포트를 **묶어주므로** 이 실패 모드가 없다. iOS만의 함정이다.

### ⛔ iOS에서 "탭은 갔는데 반응 없음"은 최소 세 가지다 — 증상으로 구분되지 않는다

| 원인 | 판별자 |
|---|---|
| **safe-area 매몰** (§D1/§FF) | 버튼의 **실측 y**를 재라. top inset(17 Pro 59pt / Pro Max 62pt)보다 작으면 이것 |
| **dev-client 기어 FAB 가로채기** (§II) | 탭 후 **무엇이 열렸나**. 개발자 메뉴가 뜨면 이것. XCUITest는 `isHittable=true`로 보고하므로 hittable은 무신호. 개발자 메뉴에서 Tools button 스위치를 꺼라(라벨 아닌 **스위치 프레임 좌표**로). 릴리즈 빌드엔 없다 |
| **제스처 recognizer 경합** (§HH) | **대조 실험**. 같은 파라미터의 드래그를 같은 화면의 다른 RN 표면(가로 ScrollView 등)에 줘라. 거기선 먹고 대상에서만 안 먹으면 이것 |

셋을 안 가르고 "안 눌린다"로 보고하면 판정이 무효다.

### 환경

```bash
xcrun simctl list runtimes          # iOS 26.5 (23F77) — 없으면 xcodebuild -downloadPlatform iOS (8.5GB)
xcrun simctl list devices booted    # iPhone 17 Pro 153F2FDE-5A37-4909-811B-6AE3B2DFC739
```

`Xcode.app` 설치만으로는 런타임이 안 생긴다 — 디바이스 타입 42종만 있고 `runtimes`가 빈다.

### 빌드

새 QA 워크트리에는 **`mobile/ios/`도 없다** (Android의 `mobile/android/`와 같은 이유 — prebuild 산출물).

```bash
npx --yes pnpm@10 install --frozen-lockfile   # pnpm은 PATH에 없다. npx로 부른다
npx expo prebuild --platform ios --no-install
(cd ios && pod install)                        # HerdrSsh가 Podfile.lock에 있는지 확인 — 조용한 미링크 가드
npx expo run:ios --device <UDID>
```

`buildReactNativeFromSource: true`라 **첫 빌드는 길다**(Pods 124개 + RN 소스). 캐시가 없으면 수십 분.

> ⚠️ **Metro 포트 충돌이 격리를 조용히 무효화한다 (2026-08-23 실측).**
> 8081이 다른 워크트리의 Metro에 잡혀 있으면 `expo run:ios`가 *"Skipping dev server"*로 넘어가고,
> 설치된 앱은 **그 다른 트리의 JS를 로드한다.** 고정 워크트리의 의미가 통째로 사라지는데
> 화면상 아무 차이가 없다. 빌드 전에 `lsof -nP -iTCP:8081 -sTCP:LISTEN`으로 주인을 확인하고,
> 남의 Metro면 **QA 워크트리의 Metro로 교체**하라(포트를 나누는 쪽이면 앱이 그 포트를 알아야 한다).

### 화면 읽기 — XCUITest 타깃 주입

`idb`도 `cliclick`도 이 머신에 없고 `simctl openurl`은 확인창을 띄운다. 그래서 **XCUITest 타깃을 넣어**
읽기와 탭을 둘 다 그 안에서 한다. `app.debugDescription`이 화면 전체를 텍스트로 뱉으므로
Android처럼 스크린샷을 비전으로 읽을 필요가 없다 — **문자열 비교로 기계 판정할 수 있다.**

프레임 좌표까지 나오므로 §R의 D1(버튼이 상태바 아래에 깔림)처럼 **"탭은 전달되는데 아무 일도 안 일어나는"**
결함을 좌표 산술로 판정할 수 있다: 버튼 `y` + 높이 < top inset이면 도달 불가다.

### mock/live 판별 — Android와 동일

정본 판별자(`reviewing PR #91`·`writing mockup html`·호스트 4종·`extra.herdrRemotes == []`)는 플랫폼 무관이다.
iOS는 그 문자열을 `debugDescription`에서 직접 grep할 수 있어 오히려 더 강하다.

### ⛔ 선행 게이트 — 코드사이닝 아이덴티티 (M2b 한정)

이 머신에 아이덴티티가 **0개**라 시뮬 앱 엔타이틀먼트가 비고, 키체인이 안 돌고, `expo-secure-store`가
아예 실행되지 않는다 → **M2b는 판정 불가**(FAIL이 아니다). M2·M3·M4는 이 게이트와 무관하게 판정 가능하다.
재서명 우회 2회는 컨테이너화가 깨져 실패했다(`containerization was prevented`) — 3회째 시도 금지, 유저 액션이다.

### iOS 사각지대

- 시뮬레이터는 기내모드·셀룰러 전환·저전력 종료를 재현하지 못한다 → **M4는 시뮬로 닫히지 않는다.**
- `exitCode`가 iOS에서 올라오지 않는다(Citadel이 `exit-status`를 노출 안 함) → `exitCode === 127`
  = "원격에 herdr 없음, 재시도 중단" 판정이 **iOS에서만 발동하지 않는다.** 다음 break 후보.
- exec 요청 응답에 상한이 없다 — Android는 sshj `client.timeout` 20초로 묶이는데 iOS는 안 묶인다.
  서버가 exec에 영영 답하지 않으면 다이얼이 매달린다.

## ⚠️ 픽스처를 고정하라 — 폭이 다르면 두 플랫폼 판정이 비교 불가다 (2026-08-23 실측)

Android (b)는 **80컬럼** pane으로 PASS했고, iOS (b)는 **240컬럼** pane으로 FAIL했다. 같은 코드가
한쪽에서 통과하고 한쪽에서 떨어진 것을 한동안 "플랫폼 갈림"으로 읽었는데, **폭이 3배 달랐다** —
402 CSS px 뷰포트에서 글자당 5px vs 1.7px이다.

| 수용 항목 | 고정 폭 | 왜 |
|---|---|---|
| **(b) pane 읽기** | **80컬럼** | 읽기를 재는 항목이다. 폰 폭을 넘는 pane은 (b)가 아니라 (e)의 대상 |
| **(e) 넓은 pane 도달** | **≥200컬럼** | 여기가 B4(폰보다 넓은 pane)를 재는 자리다 |
| (c) 무변화 | 무관 (고정만 하면 됨) | 재는 것이 기하 불변이지 가독성이 아니다 |

랩을 세울 때 `tmux new-session -x <폭> -y 52`의 폭을 **보고에 반드시 적어라.** 안 적으면 다음 사람이
플랫폼 차이와 픽스처 차이를 구별할 수 없다.

---

## QA 에이전트를 띄울 때 브리프에 반드시 넣을 것 (2026-08-23, 각각 실제 손실에서)

| 넣을 문장 | 왜 — 이걸 안 넣어서 잃은 것 |
|---|---|
| **"기다리지 말고 이 응답 안에서 끝내라. 못 본 항목은 판정 불가로 적어라."** | QA 에이전트가 긴 관측 중 *"모니터가 깨우길 기다린다"* 로 자기 턴을 끝냈다. **모니터는 서브에이전트를 깨우지 못한다** — 디스패치가 그걸로 종료된다. 재개 메시지 1회를 태웠다 |
| **각 수용 항목의 픽스처 폭을 명시** | Android (b)를 80열로, iOS (b)를 240열로 봤다. 같은 코드의 통과/실패를 "플랫폼 갈림"으로 읽었는데 폭이 3배였다 |
| **"지배색 비율이 아니라 비배경 픽셀 수로 재라"** | 98.56% vs 95.61%로는 blank와 tiny가 안 갈린다. 실측은 **비배경 0px**이었고, 30,803px의 정체는 설정 기어 FAB였다 |
| **"침묵을 결론으로 쓰려면 채널이 살아있음을 먼저 증명하라"** | `[fit]renderer` 0건이 파이프 유실인지 진짜 음성인지 갈렸다. QA가 **15초 간격 liveness 마커 7건**을 같은 채널로 흘려 증명했고, 그래서 0건이 결론이 됐다 |
| **잔여 결함을 브리프에 넣을 때 "수용 기준 위반인지" 먼저 판단** | §L1 잔여를 "재확인만 하면 된다"로 넘겼는데, 판정자가 그것이 M4의 "강제종료로만 낫는 상태 0건"을 직접 위반한다고 판정했다. **잔여로 분류하는 것과 기준을 위반하는 것은 다른 일이다** |

## 이 앱의 계측 사각지대 (2026-08-23 실측)

```
mount ──── web-ready ──── init() 완주 ──── 첫 프레임
      │                 │
   워치독이 본다      새 계측이 본다
      └───── 이 사이는 아무도 안 본다 ─────┘
```

`terminal-webview-ready-watchdog.ts:11,38-41`은 15초 안에 `web-ready`가 안 오면 치명 에러 오버레이를 띄운다.
`reportRendererIdentity()`(`3032ae3a`)는 `init()` rAF 체인의 **마지막 문장**에서만 찍는다.
**`web-ready`는 왔는데 `init()`이 완주 안 한 상태를 보고하는 것이 없다** — §U/§X가 두 라운드를 산 이유가 이것이다.
다음에 같은 모양(헤더는 건강한데 화면이 비었다)을 보면 **먼저 이 구간을 의심하라.**

---

## 체크리스트 (최소)

- [ ] APK 빌드 시각이 마지막 커밋보다 최신
- [ ] 앱이 크래시 없이 첫 화면 렌더 — `dumpsys activity` 의 `topResumedActivity` 가 `dev.herdr.mobile/.MainActivity`
- [ ] 스크린샷 1장 확보, mock/live 판정을 **명시적으로 기재**
- [ ] `adb logcat` 에 치명 예외 없음 (`*:E` 필터)
- [ ] 변경 범위에 해당하는 화면을 실제로 열어봄 (agents / nodes / pane)
- [ ] 네이티브(`modules/herdr-ssh/**`) 변경이면 **반드시 재빌드 후** — 이 층은 JS 리로드로 안 바뀐다

## 보고 형식

QA를 돌렸으면 다음을 보고에 넣는다. 하나라도 없으면 "QA 했다"고 쓰지 않는다:

1. APK 빌드 시각 + 대응 커밋
2. 스크린샷과, 거기서 **읽은 내용**
3. mock/live 판정과 그 근거(어느 문자열을 보고 판정했나)
4. 열어본 화면 목록
5. 못 한 것 — **"판정 불가"를 FAIL과 구분해 적는다.** 하네스가 없어 못 본 것은 판정 불가이지 FAIL이 아니고,
   반대로 못 본 것을 PASS로 올리지도 않는다 (iOS M2b의 서명 게이트가 이 칸의 표준 사례다)

---

## 알려진 사각지대

- ~~**iOS는 QA 불가.**~~ **stale — 2026-08-23에 Xcode 26.6 설치, 시뮬레이터 5종 가동, 첫 QA 완료(§R).**
  iOS 판독은 Android와 **반대다**: RN Fabric이 iOS에선 접근성 트리에 텍스트를 **올린다.**
  XCUITest `debugDescription`으로 화면 전체를 텍스트로 읽을 수 있다 — 스크린샷+비전보다 강하다.
  남은 iOS 게이트는 **코드사이닝 아이덴티티**(0개) — 없으면 시뮬 앱 엔타이틀먼트가 비어 키체인이 안 돌고,
  `expo-secure-store`를 쓰는 M2b가 원천적으로 판정 불가다(§R).
  탭 수단도 준비가 필요하다: idb·cliclick 없음, `simctl openurl`은 확인창을 띄운다 →
  **XCUITest 타깃을 주입**해 구동한다(§R의 하네스 절 참조).
- **에뮬레이터 ≠ 실기기.** 네트워크 전환(Wi-Fi↔LTE), 배터리, 백그라운드 종료는 에뮬레이터가 재현하지 못한다 —
  그런데 그게 `.prd/09` §O가 다룬 결함들이 사는 곳이다.
- **디버그 빌드 ≠ 배포 빌드.** Metro 의존이라 번들 임베딩·난독화·릴리즈 서명 경로는 이 절차가 안 건드린다.
