# 06 — 열린 결정 · 이전 판 대비 변경

오너가 정해야 하는 것 4개. **1번(렌더러)이 M1 착수 전 필수**다 — 한 번 고르면 되돌리기 비싸다.

Base: `feat/mobile-client` @ `aa9f6e14` = herdr **v0.8.0-mx.1**, `PROTOCOL_VERSION = 20`.
증거 표기 — `[v]` 직접 열어 확인 · `[i]` 조사 리포트 전언, 재검증 안 함 · `[추정]` 코드 근거 없음.
경로는 herdr 레포 루트 기준.

1. **렌더러.** `TerminalAnsi` + xterm WebView(권장: 코덱 부담 최소, orca 재사용 최대, 동결 대상 5필드)
   vs `SemanticFrame` + 네이티브 셀 렌더러(자유도 높고 herdr UI를 폰용으로 재해석 가능, 대신
   bincode/FNV/deflate/델타를 전부 손으로 + 매 범프마다 유지보수). **한 번 고르면 되돌리기 비싸다.**
2. **pane 뷰 폭 정책.** PTY 폭 그대로 렌더 + 핀치줌(서버 변경 0, 지금 가능) vs observe 뷰포트를 herdr에
   추가(폰에 딱 맞지만 서버 작업).
3. **홈 화면.** Agents 우선(폰에서의 실제 용도) vs 리모트/워크스페이스 트리 우선(orca 구조에 더 가까움).
4. **폰 ssh 키 권한 범위.** 제한 없는 유저 키(간단, 분실 시 셸 전체) vs `authorized_keys`의 `command=`
   강제 + 브리지 디스패치 래퍼(안전, 서버마다 한 줄 설치).

---

---

- **베이스 교체.** 이전 판은 `feat/multi-remote-client`(v0.6.8) 기준이었다. 그 브랜치는 `mx`보다 561커밋
  뒤였고 multi-remote는 이미 상륙해 있었다(`src/main.rs:550` `[v]`). 모든 줄번호가 무효였다.
- **코덱 포팅이 대부분 사라졌다.** 이전 판은 "bincode를 TS로 포팅 + 네이티브 셀 렌더러"로 직행했다.
  인코딩이 연결 모드와 직교한다는 사실([`02-architecture.md`](./02-architecture.md) §2.2)이 그 작업의 대부분을 지웠다.
- **attach → observe.** 이전 판은 `TerminalAttach`를 pane 표면으로 쓰고 "PTY가 폰 크기로 고정되는 것"을
  감수 비용으로 적었다. `ObserveTerminal`은 그 비용이 없다([`02-architecture.md`](./02-architecture.md) §2.3).
- **S1(attach 재진입 누수)은 이 베이스에 존재하지 않는다.** 재확인 결과 해제 경로와 이를 고정하는
  테스트가 있다 `[i]`. 백로그에서 제거.
- **프로토콜 항목이 "출시 전 필수"에서 "M0 선행"으로 승격됐다.** 범프 빈도를 실측했기 때문([`03-blockers.md`](./03-blockers.md) B1).
