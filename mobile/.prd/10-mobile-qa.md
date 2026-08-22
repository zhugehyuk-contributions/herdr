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

## 라이브 랩 재구축 (실측 절차, 2026-08-23)

QA 사이에 랩이 죽어 있다(sshd·tmux 종료, `app.json` 원복). 매번 다시 세워야 한다:

1. throwaway ed25519 키 2쌍 생성 (호스트키 + 유저키). **유저의 실제 키 금지.**
2. `/usr/sbin/sshd -f /tmp/<lab>/sshd_config` — 에뮬레이터에서 `10.0.2.2:<port>`로 보인다
3. `tmux -L <lab> new-session -x 240 -y 52` 안에서 herdr 클라이언트 기동
   > ⚠️ **`HERDR_ENV`·`HERDR_SESSION` 등 herdr env를 반드시 unset하라.** 안 하면
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
5. 못 한 것 — iOS는 Xcode 부재로 항상 여기 들어간다

---

## 알려진 사각지대

- **iOS는 QA 불가.** Xcode가 없어 `ios/` prebuild조차 없다. iOS 관련 변경은 "검증 안 됨"으로 보고한다.
- **에뮬레이터 ≠ 실기기.** 네트워크 전환(Wi-Fi↔LTE), 배터리, 백그라운드 종료는 에뮬레이터가 재현하지 못한다 —
  그런데 그게 `.prd/09` §O가 다룬 결함들이 사는 곳이다.
- **디버그 빌드 ≠ 배포 빌드.** Metro 의존이라 번들 임베딩·난독화·릴리즈 서명 경로는 이 절차가 안 건드린다.
