# Third-party notices — `mobile/`

herdr is Apache-2.0 (repo root `LICENSE`). This directory additionally contains source ported from
**orca**, which is MIT. MIT is compatible with inclusion in an Apache-2.0 work, and its only
condition is that the copyright and permission notice travel with the copies — this file is that
notice, and every ported file additionally carries a three-line provenance header naming its orca
path and the commit.

## orca

- Project: `orca` — https://github.com/stablyai/orca
- Commit used for this port: `4fd93ead1999dc34e13ac5915693ad8467a39a6e` (2026-08-21)
- License: MIT

> Note on the commit id: `mobile/.prd/08-orca-port-map.md` §0 records the survey as having been
> done at `1ce2e562`. The `--depth 1` clone that survives in this session's scratchpad is at
> `4fd93ead`, and that is the tree these files were actually copied from, so `4fd93ead` is what the
> headers say. The two ids are not reconcilable from a shallow clone; the discrepancy is reported
> rather than papered over.

Nothing under `mobile/` vendors orca as a dependency — the port is file-level copying, per
`mobile/.prd/08-orca-port-map.md` §0.

### License text

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Which files came from orca

Every source file under `mobile/` carries one of three markers, so the set is very nearly a
partition and the question is answerable by `grep`, not by memory. **Every number in this section is
produced by the commands below — re-run them rather than trusting the table, which is a snapshot
(2026-08-22) of a tree two agents were writing to at once.**

| Marker | Meaning | Count |
|---|---|---|
| `// Ported from orca <path>` | Copied from that orca path. 82 are byte-identical to the orca file after the three header lines; 19 differ (see below); 6 are named extractions from a larger orca file (`src/shared/runtime-terminal-theme.ts`, `src/storage/terminal-text-scales.ts`, `src/storage/sidebar-width.ts`, `src/transport/connection-state-types.ts`, `src/transport/reconnect-policy.ts`, `src/agents/agent-display.ts`), whose headers carry a `:line-range` instead of a bare path. | 107 |
| `// Rewritten for herdr` | orca's file is the shape but not the content: `metro.config.js`, `scripts/mock-server.ts`, `src/api/mock/mock-fixture.ts`, `src/api/mock/mock-api-handlers.ts`, `src/transport/connection-supervisor.ts`, `src/transport/herdr-clients-context.tsx`, `src/transport/observe-subscriptions.ts`, `src/transport/protocol-compat.ts`, `src/transport/revival-nudge.ts`. | 9 |
| `// Not from orca` | herdr-authored. Includes all 21 files of `modules/herdr-ssh` (the local Expo module), which are no longer counted separately — orca has no ssh layer to have ported one from (`mobile/.prd/02-architecture.md` §2.4). | 85 |

107 + 9 + 85 = 201 of the 205 files the scan covers. The marker is matched as a bare phrase, not as a
`//` line, because six files in `modules/herdr-ssh` have to carry it in their own comment syntax —
`#` (`.podspec`, `proguard-rules.pro`), `<!-- -->` (`AndroidManifest.xml`) and a `"//"` JSON field
(`package.json`, `expo-module.config.json`).

### Reproducing the counts

Run from `mobile/`. The root list is the whole TypeScript/JS/native surface; it is spelled out
rather than left as `.` so that `node_modules/`, `.prd/` and the lockfile stay out.

```sh
ROOTS="src app scripts plugins modules test \
  metro.config.js vitest.config.ts vitest.live.config.ts vitest.setup.ts"

# the three counts
for m in 'Ported from orca' 'Rewritten for herdr' 'Not from orca'; do
  printf '%-22s %s\n' "$m" "$(grep -rl "$m" $ROOTS | wc -l)"
done

# what carries no marker at all
grep -rLE 'Ported from orca|Rewritten for herdr|Not from orca' $ROOTS
```

The second command reports **four** files, and only the first of them is expected:

| File | Why |
|---|---|
| `src/terminal/terminal-webview-engine.generated.ts` | The gitignored xterm build artefact (`mobile/.gitignore:4`) — generated, so it has no author to attribute. Its own licence obligation is the xterm.js section below. |
| `test/live/transportRecovery.live.test.ts` | **Gap, reported not fixed.** All three are herdr-authored (`// Not from orca`) and simply never got the header. |
| `test/live/paneInput.live.test.tsx` | ″ |
| `test/live/paneViewer.live.test.tsx` | ″ |

### Reproducing identical / differ / extraction

For every file whose header names a bare orca path, strip the three header lines and diff the
remainder against the orca tree. Same `$ROOTS` as above, same working directory. Note that the strip is exactly three lines, so a file's *own*
explanatory comment block counts as a difference — several files below are "differ" for commentary
plus one import, and each says so at its top.

```sh
git clone --filter=blob:none https://github.com/stablyai/orca /tmp/orca
COMMIT=4fd93ead1999dc34e13ac5915693ad8467a39a6e

grep -rl '^// Ported from orca' $ROOTS | while read -r f; do
  p=$(sed -n "1s|^// Ported from orca ||p" "$f" | cut -d' ' -f1)
  case "$p" in *:*) echo extraction; continue;; esac        # a :line-range means an extraction
  if git -C /tmp/orca show "$COMMIT:$p" > /tmp/orca-side 2>/dev/null; then
    if diff -q /tmp/orca-side <(tail -n +4 "$f") >/dev/null
      then echo identical; else echo differ; fi
  else echo missing-from-orca; fi
done | sort | uniq -c
```

At the time of writing that reports
`82 identical / 19 differ / 6 extractions / 0 header paths missing from the orca tree`.

Of the nineteen ported files that are not byte-identical, **seven** differ *only* because orca resolved
two types and two pure functions through the desktop-shared directory `../../../src/shared/` (its
`metro.config.js` watch folder) and herdr has no such directory:

| File | Change |
|---|---|
| `src/terminal/terminal-webview-html.ts` | 2 import specifiers (`runtime-types` -> `../shared/runtime-terminal-theme`, `../storage/preferences` -> `../storage/terminal-text-scales`) |
| `src/terminal/terminal-webview-contract.ts` | 2 import specifiers |
| `src/terminal/terminal-webview-messages.ts` | 2 import specifiers |
| `src/terminal/TerminalWebView.tsx` | 1 import specifier |
| `src/terminal/terminal-webview-query-reply-routing.ts` | 1 import specifier |
| `src/terminal/terminal-path-tap.ts` | 1 import specifier |
| `src/terminal/terminal-path-tap.test.ts` | 1 import specifier |

`mobile/src/shared/` holds the five orca `src/shared` modules those specifiers now point at; they
carry the same provenance header naming their original repo-root path.

The next **eight** are adaptations, not import fixes. Each names its own changes at the top of
the file; the summary is:

| File | Change |
|---|---|
| `app/_layout.tsx` | Route shell. Pairing deep links, relay recovery, notification tap routing, `OrcaLogo` and `RpcClientProvider` removed (all `drop` or later-stage in the port map); screen list cut from fourteen to the two routes that exist; palette swapped to `src/theme/monotone.ts`. The splash timing, `screenOptions` and the "no `orientation` option" rule are orca's, verbatim. |
| `app/h/_layout.tsx` | Master-detail shell. `host` -> `remote` at the route-segment/identifier/title level, `HostProtocolGate` wrapper removed (stage 8), screen list cut from nine to one, palette swapped. Every load-bearing behaviour — window-aware clamp, `MIN_DETAIL_WIDTH`, the edge-handle `PanResponder` and its Android reason, the "no reveal button" rule, the stable detail-Stack position — is unchanged. |
| `src/components/StatusDot.tsx` | Colour table -> the monotone ramp, and the `unreachable`/`auth-failed` dot becomes a ring (emphasis by inversion). Verdict-overrides-state structure unchanged. Type imports point at `src/transport/connection-state-types.ts` (extraction) because orca's transport layer is stage 6+. |
| `src/components/AgentStateDot.tsx` | State vocabulary -> herdr's API `AgentStatus` (`idle\|working\|blocked\|done\|unknown`) instead of orca's `AgentDotState`; colour table -> the monotone ramp; `blocked` becomes a ring. The `working` rotation animation is orca's, unchanged. |
| `src/components/AgentRow.tsx` (orca `WorktreeAgentRow.tsx`) | Lineage indent, the time-ago column and `unvisited` dropped — herdr's `AgentInfo` has no parent pointer and no timestamp of any kind. Optional second line + `onPress` added, because the Agents home is cross-remote and each row is its own tap target. |
| `src/components/AgentSummary.tsx` (orca `WorktreeAgentSummary.tsx`) | `MobileAgentIcon` (orca's agent-brand SVG set) -> the agent's own name; `agentDotState(agent, now)` -> the wire's `agent_status`; palette -> the monotone ramp. `MAX_VISIBLE_AGENTS`, the `+N` overflow, the chevron pair, the accessibility contract and the `stopPropagation` are orca's, unchanged. |
| `src/components/AgentList.tsx` (orca `WorktreeAgentList.tsx`) | The spawn-lineage flatten is dropped (`src/worktree/agent-row-lineage.ts`, 88 lines, is consequently not ported at all): herdr's `agent.list` publishes no `parentPaneKey`, so the flatten would be the identity. The collapse rule — summary chip iff more than one agent — is orca's. |
| `src/components/WorkspaceListRow.tsx` (orca `WorktreeListRow.tsx`) | `AgentSpinner` -> `AgentStateDot`, because orca's spinner is hued by design and `src/theme/monotone-discipline.test.tsx` enforces the ramp on exactly this surface. PR/issue/Linear/GitLab badges, `WorktreeMetaGlyphs`, `MobileRepoIcon`, `unread`, lineage and long-press haptics dropped (all fed by orca RPCs herdr's JSON API does not have). The lineage toggle keeps its position and becomes the pane toggle. The three-column geometry, the transparent reserved accent border, `alignItems: 'flex-start'`, `displayBranch` and the `hideRepo` de-duplication rule are orca's. |

The last **four** joined the list with the transport milestone (M4) and the runner change under it:

| File | Change |
|---|---|
| `src/transport/rpc-stale-dial.ts` | One import (`./types` -> `./connection-state-types`, the extraction) and an `export { STALE_DIAL_AGE_MS }` so the live receipt asserts the constant instead of restating it. Every line of the rule itself is orca's. |
| `src/transport/request-single-flight.ts` | Three renames and nothing else: `RpcClient` -> `JsonApiClient`, `sendRequest` -> `request`, `RpcResponse` -> `JsonApiResult`. The keyed map, the single trailing follow-up and the recursive `onSettled` are orca's line for line. |
| `src/transport/connection-health.ts` | `isTailscaleEndpoint` (which reads an *address*) -> an injected hint derived from the channel's exit status by `./channel-failure.ts`; orca's relay branch dropped (ssh *is* the relay, `mobile/.prd/02-architecture.md` §2.5); `pairingRejected` -> `fatalFailure`, herdr having no pairing. The thresholds and the order of the gates are orca's, unchanged. |
| `vitest.config.ts` | One entry added to `include` (`modules/**/*.test.ts`), because a local Expo module lives outside `src/` by autolinking convention and its TypeScript half is the only part of the native ssh path testable without a device. |

`src/agents/agent-display.ts` is the sixth named extraction (orca
`mobile/src/worktree/agent-row-display.ts:33-64`): orca's rule that an agent row never renders blank,
over herdr's fields. orca's staleness decay, `formatTimeAgo` and the two-letter agent code table are
not ported — the first two have no timestamp to read on herdr's wire, the third exists only as a
fallback for an icon set that is not ported.

Why the palette diverges at all: herdr's mobile mockup fixes a monotone grayscale ramp with emphasis
by inversion (`mobile/.prd/assets/mockup.html:863`), while orca's `mobile-theme.ts` is hued. That
file stays byte-identical to orca so the ported modal/drawer chrome keeps compiling unmodified, and
the new ramp lives beside it in `src/theme/monotone.ts` (`// Not from orca`). Only surfaces where
colour *is* the meaning read from the new one; `src/theme/monotone-discipline.test.tsx` enforces it.

`.oxlintrc.json` is also derived from orca (root config + mobile overlay, flattened); oxlint rejects
unknown top-level keys, so its provenance note lives in `.oxlintrc.README.md`. `package.json`,
`tsconfig.json`, `tsconfig.test.json` and `app.json` are structured after orca's and say so in a
`"//"` field.


---

## xterm.js — 앱 번들에 **인라인**되어 배포된다 (MIT)

`scripts/build-terminal-webview-engine.mjs`가 아래 패키지를 하나의 문자열 상수로 번들해
`src/terminal/terminal-webview-engine.generated.ts`를 만들고, 그 문자열이 WebView 문서에 삽입된다.
생성물은 `.gitignore` 대상이라 레포에 없지만 **빌드된 앱에는 실려 나간다** — 따라서 여기 고지한다.
(일반적인 런타임 의존성과 달리 소스가 우리 번들 안으로 들어오므로 별도 항목으로 둔다.)

| 패키지 | 버전 | 저작권 |
|---|---|---|
| `@xterm/xterm` | 6.1.0-beta.285 | (c) 2017-2019 The xterm.js authors · (c) 2014-2016 SourceLair Private Company · (c) 2012-2013 Christopher Jeffrey |
| `@xterm/addon-unicode11` | 0.10.0-beta.285 | (c) 2019 The xterm.js authors |
| `@xterm/addon-webgl` | 0.20.0-beta.284 | (c) 2018 The xterm.js authors |

셋 다 **MIT License**. 전문은 각 패키지의 `node_modules/<pkg>/LICENSE`에 있으며, 배포물에는
그 전문을 동봉해야 한다 — 릴리즈 파이프라인이 생기면 이 표를 그 단계의 체크리스트로 쓴다.

> 이 항목이 빠져 있었다(2026-08-22 발견). 생성 파일이 gitignore라 레포 스캔에는 안 잡히지만
> **배포되는 것이 기준**이다.

---

## ssh — `mobile/modules/herdr-ssh`의 네이티브 의존성 (앱에 링크되어 배포된다)

React Native에는 ssh 스택이 없어서 네이티브 모듈 하나를 직접 싼다
(`mobile/.prd/02-architecture.md` §2.4). 아래 셋은 **빌드된 앱 바이너리 안에 링크되어 나간다** —
`node_modules`에 없어서 레포 스캔에는 잡히지 않지만, xterm 항목과 같은 이유로 여기 고지한다.

| 라이브러리 | 플랫폼 | 버전(핀) | 라이선스 | 링크 방식 |
|---|---|---|---|---|
| [`hierynomus/sshj`](https://github.com/hierynomus/sshj) | Android | 0.40.0 | **Apache-2.0** | Maven (`modules/herdr-ssh/android/build.gradle`) |
| [`orlandos-nl/Citadel`](https://github.com/orlandos-nl/Citadel) | iOS | 0.12.1 | **MIT** | SPM (`plugins/with-herdr-ssh-spm.js`) |
| [`apple/swift-nio-ssh`](https://github.com/apple/swift-nio-ssh) | iOS | Citadel 경유 (0.15.x) | **Apache-2.0** | SPM, 전이 의존 |

전이 의존으로 함께 들어오는 것: Android는 BouncyCastle(`bcprov`/`bcpkix`, **MIT** — `bcgit/bc-java`)과
`net.i2p.crypto:eddsa`(**CC0-1.0** — `str4d/ed25519-java`)와 `org.slf4j:slf4j-nop`(**MIT**); iOS는
`apple/swift-nio`·`apple/swift-crypto`(둘 다 **Apache-2.0**).

**라이선스 판정**: herdr은 Apache-2.0이다. Apache-2.0(sshj, swift-nio-ssh, swift-nio, swift-crypto)은
동일 라이선스, MIT/CC0/BC는 Apache-2.0 저작물에 포함 가능하며 조건은 저작권·허가 고지가 배포물에
동행하는 것 — 이 표가 그 고지의 근거이고, 릴리즈 파이프라인이 생기면 각 프로젝트의 `LICENSE`
전문을 동봉하는 단계의 체크리스트로 쓴다. **GPL/LGPL/AGPL 계열은 하나도 없다.**

선택 근거(유지보수 상태 실측 포함)와 탈락한 후보(NMSSH 2018·CocoaPods `libssh2` 2014·`mwiede/jsch`
SPDX 미표기)는 `mobile/modules/herdr-ssh/README.md`에 있다.

> ⚠️ 이 표의 라이브러리들은 **아직 한 번도 빌드되지 않았다** — `expo prebuild`/`pod install`/Gradle
> 동기화 모두 미실행. 버전 핀은 소스에 적힌 값이고, 실제로 해석되는 버전은 첫 빌드에서 확정된다.
