# 05 — orca transport 생존성 이식표

orca가 프로덕션에서 값을 치르고 얻은 해법 목록. 출처는 orca `mobile/src/transport/` 와
`mobile/issue-5049-unresponsive-session-findings.md` — **이 레포에 벤더링하지 않는다**:

```bash
git clone --depth 1 https://github.com/stablyai/orca.git
```

⚠️ **주의**: 아래 "그대로 적용" 판정은 orca가 **WebSocket** 위에서 얻은 결과다. herdr 앱은 ssh
exec 채널을 쓰고 RN의 WebSocket과 달리 OS가 관리해 주지 않는다. **전송이 바뀌면 재검증 대상**이며,
M1 착수 전 ssh 스파이크(실기기, transport 1 + exec 채널 2, 30분 백그라운드 후 복귀 시 생존/재연결 소요 측정)로
숫자를 확보해야 한다.

이 목록의 대부분은 WebSocket 얘기가 아니라 **OS가 JS 타이머를 정지시키고 소켓을 조용히 죽이는 것**에
대한 얘기라 ssh 전송에도 그대로 적용된다. 출처는 orca `mobile/src/transport/` 와
`issue-5049-unresponsive-session-findings.md` `[i]`.

| # | 실패 모드 | 해법 | herdr 적용 |
|---|---|---|---|
| **L3** | **재연결 루프가 영구 주차** (orca #5049 근본원인) | 시도 상한 이후 **멈추지 않고** 긴 간격으로 계속 재시도, attempt는 상한에 고정 | **이 목록에서 제일 중요한 한 줄.** herdr 데스크톱도 형태는 맞다(무한 백오프) — TS로 재구현 |
| L1 | 반열림 연결 — 보내지는데 아무것도 안 감 | 3-strike 워치독(idle 20s / timeout 8s / 3 miss), 프로브는 **실제 RPC** | 그대로. herdr에 `Ping/Pong{nonce}` 존재. 주기는 배터리·데이터 고려해 orca 수치 채택 |
| L1b | JS 정지 후 복귀 시 즉시 3연속 오탐 | 실측 경과가 timeout×1.5 초과면 miss로 세지 않는다 | 그대로, 전송 무관 |
| L2 | 강제 teardown인데 close 이벤트가 안 옴 | 닫고 close를 손으로 합성 | 그대로. 신호만 교체: ssh 자식 exit status / stdout stall |
| L4 | 백그라운드 예산 소진 → 복귀해도 안 살아남 | AppState active + 네트워크 복귀 + **Wi-Fi↔셀룰러 타입 변경**을 nudge 하나로 통합 | 그대로 |
| L5 | 절전 중 다이얼이 멈춤 | 2초 넘은 다이얼은 포기하고 재다이얼, 단 **attempt 카운터는 깎지 않는다**(깎으면 UI가 영원히 "연결 중") | 그대로 |
| L6 | "연결 중…" 라벨이 실패 루프를 가림 | 에스컬레이션 사다리를 transport의 give-up 상한에 핀 고정 | 그대로. 힌트만 교체: `Permission denied (publickey)` / `herdr: command not found` / 프로토콜 불일치 |
| L7 | 유일한 복구가 앱 강제종료 | 상태줄을 탭 가능하게 + Retry가 **transport를 되살리게**(요청 재전송이 아니라) | 그대로 |
| X1 | 재연결 후 아무것도 안 나옴 | 모든 구독을 저장해 재연결 시 replay | 그대로. herdr엔 `RequestFullFrame`이 양쪽에 이미 있다(`wire.rs:467` `[v]`) |
| X1b | 재연결했더니 예전 크기로 붙음 | **뷰포트를 저장된 구독 params 안에** 넣는다 | 재연결 `Hello`의 cols/rows + observe 타깃을 함께 저장 |
| X2 | 마지막 write가 배달됐는지 모름 | delivery-unknown 표시(실패로 단정 금지) + 끊긴 상태의 키 입력은 즉시 거절 | **터미널이라 RPC보다 더 중요.** `pane.send_input`은 **절대 큐잉하지 않는다** |
| X3 | 화면이 백지인데 에러 이벤트가 없음 | WebView ready 워치독, 단 백그라운드면 판정하지 않고 재무장 | 그대로(xterm WebView를 쓰므로 동일) |
| X4 | 화면이 교체된 client 핸들을 붙잡고 있음 | forceReconnect가 스토어 엔트리를 통째로 교체, 훅은 **모든 상태변화마다** 재조회 | 그대로 |
| X5 | 복귀 순간 N개 화면이 동시에 같은 새로고침 | (client, host, kind) 키의 single-flight + trailing follow-up | 그대로. **B8이 남아있는 동안 특히 필수** |
| X6 | 버전 불일치가 원인불명 재연결 루프로 보임 | 양방향 창 + 하드 블록 화면 | = B1 |
| P1 | 폰 없이 디버깅 불가 | mock 서버 + 폰 없는 재현 스크립트, 그리고 **"폰 없는 재현부터 돌려라, 실패하면 UI를 건드리지 마라"**는 명문 경계 | **M1의 헤드리스 코어가 이 역할.** orca는 이 순서 덕에 #5049 인접 버그가 **서버 쪽**이었음을 찾아냈다 |

**전송-특이라 그대로 오지 않는 것**: `readyState` 판정(→ ssh는 "자식 살아있고 파이프 열렸는데 바이트가
안 옴"), WebSocket close code(→ 자식 exit status + stderr), RN/OkHttp 프로세스 오염(등가물 없음),
E2EE 핸드셰이크(→ ssh 인증이 대체. 단 핸드셰이크 타임아웃은 "ssh는 붙었는데 원격 herdr이 말을 안 함"으로 매핑).

---
