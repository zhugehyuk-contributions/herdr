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

Every source file under `mobile/` opens with one of three markers, so the set is a partition and
the question is answerable by `grep`, not by memory:

| Marker | Meaning | Count |
|---|---|---|
| `// Ported from orca <path>` | Copied from that orca path. 49 are byte-identical to the orca file after the three header lines; 7 differ only in import specifiers (see below); 2 are named extractions from a larger orca file (`src/shared/runtime-terminal-theme.ts`, `src/storage/terminal-text-scales.ts`). | 58 |
| `// Rewritten for herdr` | orca's file is the shape but not the content. `metro.config.js` only. | 1 |
| `// Not from orca` | herdr-authored. | 3 |

Machine check that nothing slipped in unmarked:

```
grep -rLE 'Ported from orca|Rewritten for herdr|Not from orca' \
  mobile/src mobile/scripts mobile/plugins mobile/vitest.config.ts mobile/vitest.setup.ts
```

The seven ported files that are not byte-identical differ **only** because orca resolved two types and
two pure functions through the desktop-shared directory `../../../src/shared/` (its
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
