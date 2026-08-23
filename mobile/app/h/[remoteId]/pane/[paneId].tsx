// Not from orca as a file — it is the **decomposed** port of orca's
// `app/h/[hostId]/session/[worktreeId].tsx`, which the port map forbids taking whole (§6 위험 2:
// "통째로 가져오면 herdr에 없는 RPC 수십 개를 함께 끌고 온다. 훅·순수함수 단위로만 뽑아라").
// That file is 5,333 lines; what is taken and what is left is recorded here rather than in a commit
// message, because the *omissions* are the design.
//
// Taken, by unit:
//   · `TerminalPaneView` (`src/session/TerminalPaneView.tsx`, 105 lines) — copied next to this
//     file; the absolute-fill + `pointerEvents` + hidden-but-mounted structure and the
//     keyboard-lift transform are orca's. It was byte-identical until M6a's iOS repair added one
//     pass-through prop (`onPaneSwipe`); that file's header states the divergence and its reason.
//   · the chip strip — orca's `:4413-4460` horizontal `ScrollView` of `Pressable`s, its
//     `keyboardShouldPersistTaps="handled"` (its comment cites #5106: taps eaten by keyboard
//     dismissal) and the reveal arithmetic in `tab-strip-scroll.ts`, copied byte-identically.
//   · the selection rule — `active-session-tab.ts`, copied byte-identically, applied in
//     `src/session/pane-chips.ts`.
//   · the status line's *shape* — `:4191-4203`, a single right-aligned summary that doubles as the
//     connection verdict.
//
//   · **M3, the write path** — `src/session/PaneInputBar.tsx` (the quick-command row, the accessory
//     key row and the text field, i.e. orca's `:4413-4460` neighbourhood rebuilt against
//     `pane.send_input`), plus `onTerminalInput`: the WebView's own keyboard/IME path (xterm
//     `onData`) routed to `pane.send_input{text}`. It is *not* routed to the wire — `ObserveTerminal`
//     drops client input on purpose (`src/server/headless.rs:2882-2886`) and every wire alternative
//     resizes the shared PTY (`:2665-2675`). That is 02-architecture.md §2.3 in one prop.
//
// Left behind, and why (each is a whole subsystem in that file, not a line):
//   · the native chat overlay, dictation, paste, and the reorderable/configurable form of the
//     accessory row — see the header of `src/session/PaneInputBar.tsx`.
//   · the keyboard-avoidance machinery (`:4205-4211` and `computeActiveTerminalKeyboardLift`) —
//     it exists to keep a *caret* above a soft keyboard, and that lift needs the metrics stream plus
//     a measured layout this screen does not have. `keyboardLift` stays 0. What the keyboard meets
//     first here is not the caret but the input bar below the terminal frame, and .prd/09 §BB is
//     that bar going under it on iOS — fixed where the bar lives (`src/session/PaneInputBar.tsx` +
//     `src/layout/keyboard-clearance.ts`), by moving the bar and nothing else, so the pane's
//     geometry — and therefore the PTY — stays exactly where M3 measured it.
//   · files / source-control / PR / diff / tasks / browser panels — no `git.*` or `files.*` in
//     herdr's JSON API (§2.2).
//   · `mobile-terminal-viewport-resubscribe` — the fit loop that resizes the *desktop* PTY to the
//     phone. Dropped whole (§6 위험 3); its replacement is `src/session/observer-geometry.ts`.
//
//   · **M4, the survivability line** — orca's `:4191-4203` in full. The header now carries the
//     *connection verdict* beside the stream summary: it escalates with the reconnect loop (L6) and
//     becomes a Retry that revives the transport rather than resending a request (L7).
//     `src/components/ConnectionStatusLine.tsx` is the component and
//     `src/transport/use-connection-status.ts` the reader; both render nothing when the remote has
//     no supervisor, which is the mock build and every build before this milestone.
//
//     Two readings side by side, on purpose, because they answer different questions and a terminal
//     needs both: `streamSummary` describes **this pane's observe stream** (idle / observing /
//     stream ended) and the verdict describes **the connection underneath it**. A screen with only
//     the first says "observing" over a link that died forty seconds ago; one with only the second
//     says "Connected" over a pane whose stream never got its `Welcome`.
//
//   · **M6c, reading what scrolled past** — `src/session/PaneHistoryOverlay.tsx` behind a header
//     button, fed by `usePaneHistory` / `pane.read`. It is the *only* item in this file with no orca
//     counterpart at all, and the reason is in `src/session/pane-history.ts`: orca's desktop pushes
//     a serialized xterm scrollback and then streams raw PTY bytes, so its history is the terminal
//     buffer; herdr's renderer writes an absolute cursor position before every cell
//     (`src/protocol/render_ansi.rs:613`), which overwrites the viewport instead of scrolling it, so
//     nothing ever enters that buffer (QA: `scrollHeight == clientHeight`, `.prd/09` §CC). History
//     therefore has to be a *server read on a separate surface*, and it must not be appended to the
//     xterm buffer, which the next frame would overwrite. The affordance is a button and not a drag
//     because M6a gave the vertical axis to the terminal (`failOffsetY`, below) and taking it back
//     would kill the swipe routing this same milestone repaired.
//
// One structural divergence from orca, deliberate: orca mounts **every** terminal and hides the
// inactive ones (`:4667` `terminals.map(...)`) so a tab switch is instant. Here exactly one pane is
// mounted, because a mounted pane is a resident ssh channel plus an uncompressed ANSI stream
// (blockers B8, B13) — N of those on LTE is not a background cost, it is the connection.
//
// That used to cost a re-handshake per switch, and this comment used to say so — "the price is that
// switching re-handshakes … herdr has no message to move an observe target, so even a warm channel
// could not retarget today" (B6). **That was wrong, and .prd/04-milestones.md M6 carries the same
// correction.** `RetargetTerminal` exists and the server handles it end to end
// (`src/server/client_transport.rs:988` → `src/server/headless.rs:3368`); the TS codec emits it
// (`packages/herdr-client-ts/src/messages.ts:232`); and `PaneObserver.retarget`
// (`src/session/pane-observer.ts`) sends it **on the channel that is already open** — `pane.layout`,
// a `Resize` only when the geometry demands one, then `RetargetTerminal{Observe}`. So a switch
// moves the observe target on a warm channel: no dial, no `Hello`/`Welcome`, no second ssh channel,
// and the observer is not even remounted (it is keyed to the connection, not to the pane).
// `src/session/use-pane-observer.ts:80-89` is the caller and it fires on a changed pane id — which
// is why both switch affordances here, the chip and the M6a swipe, do nothing but route.
import { useCallback, useMemo, useRef } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AgentStateDot } from '../../../../src/components/AgentStateDot'
import { ConnectionStatusLine } from '../../../../src/components/ConnectionStatusLine'
import { useRemote, useRemoteSnapshot } from '../../../../src/api/snapshot-context'
import { agentIdentityLabel, agentStateLabel } from '../../../../src/agents/agent-display'
import {
  useHerdrConnection,
  useHerdrSupervisor
} from '../../../../src/transport/herdr-clients-context'
import { useConnectionStatus } from '../../../../src/transport/use-connection-status'
import { TerminalPaneView } from '../../../../src/session/TerminalPaneView'
import { buildPaneChips, resolveActivePaneChip } from '../../../../src/session/pane-chips'
import {
  PANE_SWIPE_ACTIVATE_OFFSET_X,
  PANE_SWIPE_FAIL_OFFSET_Y,
  resolvePaneSwipeTarget,
  type PaneSwipeTranslation
} from '../../../../src/session/pane-swipe'
import { usePaneObserver } from '../../../../src/session/use-pane-observer'
import { usePaneInput } from '../../../../src/session/use-pane-input'
import { usePaneHistory } from '../../../../src/session/use-pane-history'
import { PaneHistoryOverlay } from '../../../../src/session/PaneHistoryOverlay'
import { PaneInputBar } from '../../../../src/session/PaneInputBar'
import { safeChromePadding } from '../../../../src/layout/safe-area-chrome'
import { typography } from '../../../../src/theme/mobile-theme'
import { mono } from '../../../../src/theme/monotone'

// Same floor and the same §D1 reasoning as `../index.tsx`: this header is drawn with 16 and, until
// the inset arrived, 16 was under the status bar on every phone this app runs on.
const HEADER_TOP_PADDING = 16
import type { TerminalWebViewHandle } from '../../../../src/terminal/terminal-webview-contract'
import type { PaneInfo } from '../../../../src/api/herdr-api-types'

/** The one line the header shows about the stream, in the slot orca gives its connection verdict. */
function streamSummary(status: string, error: string | null, connected: boolean): string {
  if (!connected) {
    return 'no transport'
  }
  if (error !== null) {
    return error
  }
  switch (status) {
    case 'observing':
      return 'observing'
    case 'connecting':
      return 'connecting'
    case 'closed':
      return 'stream ended'
    case 'failed':
      return 'stream failed'
    default:
      return 'idle'
  }
}

function paneTitle(pane: PaneInfo): string {
  return agentIdentityLabel({
    agent_status: pane.agent_status,
    state_labels: pane.state_labels,
    display_agent: pane.display_agent,
    agent: pane.agent,
    title: pane.title,
    terminal_title_stripped: pane.terminal_title_stripped
  })
}

export function PaneViewerScreen({
  remoteId,
  paneId,
  onSelectPane
}: {
  remoteId?: string
  paneId?: string
  /** Chip taps route in the app; a caller that owns navigation itself passes this instead. */
  onSelectPane?: (paneId: string) => void
}) {
  // Navigation this screen owns: the back breadcrumb (.prd/11 누락 #10). Chip taps stay on
  // `onSelectPane` so a caller that owns navigation can keep owning it.
  const router = useRouter()
  const remote = useRemote(remoteId)
  const entry = useRemoteSnapshot(remoteId)
  const connection = useHerdrConnection(remoteId)
  // M4/X4: the *supervisor*, not a link. `useConnectionStatus` re-reads it on every state change
  // through `useSyncExternalStore`, so this screen can never hold a link `forceReconnect` replaced.
  // Both are null in a build with no transport supervision, and the status line renders nothing.
  const supervised = useHerdrSupervisor(remoteId)
  const connectionStatus = useConnectionStatus(supervised)
  const insets = useSafeAreaInsets()
  const handleRef = useRef<TerminalWebViewHandle | null>(null)

  const routed = entry?.panes.find((pane) => pane.pane_id === paneId) ?? null
  // Siblings = every pane of the *workspace*, across its tabs: 01-spec.md flattens the tab layer
  // into the viewer ("tab은 pane 그룹이므로 뷰어 안의 세그먼트로 평탄화한다"), so the strip spans
  // tabs and the tab survives only as each chip's label.
  const siblings = useMemo(
    () =>
      routed
        ? (entry?.panes ?? []).filter((pane) => pane.workspace_id === routed.workspace_id)
        : [],
    [entry, routed]
  )
  const agents = useMemo(
    () =>
      routed
        ? (entry?.agents ?? []).filter((agent) => agent.workspace_id === routed.workspace_id)
        : [],
    [entry, routed]
  )
  const chips = useMemo(() => buildPaneChips(siblings, agents), [agents, siblings])
  const active = resolveActivePaneChip(chips, paneId).activeTab
  const activePane = siblings.find((pane) => pane.pane_id === active?.paneId) ?? routed

  const observer = usePaneObserver({
    connection,
    paneId: active?.paneId ?? null,
    viewportRows: activePane?.scroll?.viewport_rows ?? null,
    handleRef,
    // §Q: the pane's own stream re-attaches on L3's ladder, and a transport that just handshook is
    // the evidence that lets it skip the wait. Null when this remote is unsupervised, which is the
    // mock build and every build before M4 — there the ladder is the only trigger.
    connectionState: connectionStatus?.state ?? null
  })
  // Targets the *active chip's* pane, exactly like the observer above, so the screen you are
  // reading and the pane you are typing into cannot drift apart. `usePaneInput` rebuilds its sender
  // when that id changes and drops anything unsent (`src/session/pane-input.ts`, `close`).
  const input = usePaneInput({ connection, paneId: active?.paneId ?? null })

  // M6c. Same pane id as the observer and the input, for the same reason: the history you read must
  // be the history of the pane you are looking at. It shares nothing else with them — `pane.read` is
  // the JSON API (one exec per call, B8), while the screen above it is the framed observe stream, so
  // opening this cannot disturb the live pane and closing it returns to a stream that never stopped.
  const history = usePaneHistory({ connection, paneId: active?.paneId ?? null })

  // The soft keyboard, when it is opened by tapping the terminal itself: xterm's textarea receives
  // the IME and emits `onData`, the document forwards it, and it arrives here as bytes. They go out
  // as `text` — `encode_api_text` (`src/app/api_helpers.rs:24-33`) sends them raw (bracketed when
  // the pane asked for it), which is the right shape for typed prose. Named keys are the *other*
  // path (`PaneInputBar`), because a key has to be encoded by the pane, not by the phone.
  const { send: sendInput } = input
  const onTerminalInput = useCallback(
    (_handle: string, bytes: string) => {
      void sendInput({ text: bytes, keys: [] })
    },
    [sendInput]
  )

  // M6a. A swipe lands on the same callback a chip tap does — `onSelectPane`, i.e.
  // `router.setParams({paneId})` and back in as a route param. It deliberately does **not** call
  // `observer.retarget()`: that would move the stream under a URL still naming the old pane, and the
  // URL is what Back, a deep link and a notification tap
  // (`src/notifications/pane-deep-link.ts`) all restore from. The retarget happens anyway, one hop
  // later, in `use-pane-observer.ts:80-89`.
  const onPaneSwipe = useCallback(
    (event: PaneSwipeTranslation) => {
      const target = resolvePaneSwipeTarget(chips, active?.id ?? null, event)
      if (target !== null) {
        onSelectPane?.(target)
      }
    },
    [active?.id, chips, onSelectPane]
  )
  const paneSwipe = useMemo(
    () =>
      Gesture.Pan()
        // The callback routes and sets React state, so it belongs on the JS thread; RNGH would
        // otherwise require it to be a worklet.
        .runOnJS(true)
        // This pair *is* "do not steal the terminal's gestures", as numbers rather than as a
        // promise (`src/session/pane-swipe.ts` explains each): the recognizer stays asleep until the
        // finger has travelled ±32 horizontally — more than the WebView's own 24px tap slop — and
        // fails outright the moment it travels ±12 vertically, which is where scrollback,
        // alt-screen scroll and selection edge-scroll live. Until it activates the WebView receives
        // every touch unchanged; on activation delivery to it simply stops mid-gesture.
        //
        // That last clause used to read "only on activation does it get a cancel", and it was wrong
        // in a way that cost a QA cycle (.prd/09 §CC read `touchcancel === 0` as proof the
        // recognizer never activated). Android RNGH does not inject an ACTION_CANCEL into this
        // WebView; the root view stops forwarding the rest of the gesture to its children. Measured
        // on emulator-5554, counting listeners inside the terminal document:
        //   · vertical drag (pan FAILED)      → touchstart 1, touchmove 24, touchend 1, cancel 0
        //   · horizontal drag (pan ACTIVATED) → touchstart 1, touchmove  1, touchend 0, cancel 0
        // So the signal that the recognizer took the gesture is the **missing touchend**, not a
        // touchcancel. `touchcancel` is 0 in both states and discriminates nothing.
        .activeOffsetX([-PANE_SWIPE_ACTIVATE_OFFSET_X, PANE_SWIPE_ACTIVATE_OFFSET_X])
        .failOffsetY([-PANE_SWIPE_FAIL_OFFSET_Y, PANE_SWIPE_FAIL_OFFSET_Y])
        // §HH's instrument, and it is here because no other signal can tell the two iOS failures
        // apart. On iOS the recognizer produced no pane switch while the *same* synthetic drag
        // scrolled an RN ScrollView 425pt away on the same screen — which leaves two stories:
        // the recognizer never activated (something upstream holds the touches), or it activated
        // and `paneSwipeDirection` rejected. Those need opposite fixes, and the only place the
        // difference is visible is whether these callbacks run at all.
        //
        // `console.log` rather than the connection log: this has to survive the case where React
        // state never updates, and Metro's stream is the one channel that does not depend on the
        // app re-rendering. Cheap enough to keep — a pan emits at most three lines per gesture,
        // and only while a finger is on the terminal.
        .onBegin(() => console.log('[paneSwipe] begin'))
        .onStart(() => console.log('[paneSwipe] start'))
        .onFinalize((event, success) =>
          console.log(
            `[paneSwipe] finalize success=${String(success)} ` +
              `dx=${Math.round(event.translationX)} dy=${Math.round(event.translationY)}`
          )
        )
        .onEnd(onPaneSwipe),
    [onPaneSwipe]
  )

  return (
    <View style={styles.screen}>
      <View
        style={[styles.header, { paddingTop: safeChromePadding(insets.top, HEADER_TOP_PADDING) }]}
      >
        {/* .prd/11 누락 #10. The mockup draws a back chevron on screens ④⑤⑥ and it is not
            decoration: `app/h/_layout.tsx:56` sets `headerShown: false`, so without this the only
            way up the tree is Android's hardware back or an iOS edge swipe — neither is visible,
            and neither exists on the master-detail layout. Labelled with the node rather than the
            workspace the mockup shows (`‹ llmux`) because ④ and ⑤ are one screen here, and that
            screen's title *is* the node — so this names where the tap actually lands. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="back to workspaces"
          onPress={() => router.push(`/h/${remoteId ?? ''}`)}
          style={styles.back}
        >
          <Text style={styles.backLabel}>{`‹ ${remote?.name ?? 'nodes'}`}</Text>
        </Pressable>
        <Text style={styles.title}>{active ? active.handle : (paneId ?? 'Pane')}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {activePane ? paneTitle(activePane) : (remote?.name ?? remoteId ?? '')}
        </Text>
        <View style={styles.spacer} />
        {/* .prd/11 누락 #15 is satisfied by the back crumb at the start of this bar, not by a
            second slot here. There *was* one, and the 2차 device QA measured what it cost: the node
            name appeared twice (`‹ qa-lab` and `qa-lab`), pushed the row past the bezel, and the
            connection status hard-cut at x=1079 with no ellipsis — the one clipping that got worse
            when the chrome became monospaced. The defect #15 named was "the node vanishes on the
            normal path"; a crumb that always renders it fixes that without spending the width
            twice. */}
        {/* M6c's entry point, and it is a button on purpose — see this file's header and
            `src/session/PaneHistoryOverlay.tsx`. Placed immediately after the spacer so a long
            agent label cannot push it off the row; the two meta readings that follow may be
            clipped, this may not. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open pane history"
          accessibilityHint="Reads this pane's scrollback from the remote"
          disabled={!history.enabled}
          style={[styles.headerAction, !history.enabled && styles.headerActionDisabled]}
          onPress={history.open}
        >
          <Text style={styles.headerActionLabel}>History</Text>
        </Pressable>
      </View>

      {chips.length > 1 ? (
        <View style={styles.chipBar}>
          {/* orca `:4416-4420`: taps must register on first press with the keyboard open. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipContent}
          >
            {chips.map((chip) => (
              <Pressable
                key={chip.id}
                accessibilityRole="button"
                accessibilityLabel={`${chip.tabLabel} ${chip.handle}`}
                style={[styles.chip, chip.id === active?.id && styles.chipActive]}
                onPress={() => onSelectPane?.(chip.paneId)}
              >
                <AgentStateDot state={chip.status} />
                <Text style={styles.chipLabel}>{chip.handle}</Text>
                {/* .prd/11 N3. This slot used to carry `chip.tabLabel` — `tab 1 · agents` — which
                    repeats the section header the chips already sit under and is long enough that
                    the third chip clipped off screen. The mockup's chip is `1-1 claude`: the
                    handle and *who is in it*, which is the only thing that distinguishes one chip
                    from the next. */}
                <Text style={styles.chipTab} numberOfLines={1}>
                  {chip.agentLabel}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* The gesture root is scoped to this screen rather than installed in `app/_layout.tsx`:
          RNGH needs one above every handler on Android, and this is the app's only gesture surface,
          so keeping it here leaves the root layout — and the five suites that mount it — untouched.
          Move it up the day a second screen grows a handler. It replaces the frame `View`, and the
          extra `flex: 1` child below is `GestureDetector`'s single-child requirement; both measure
          exactly what the old frame measured, so the pane's geometry — and therefore the PTY —
          is unchanged (M3). */}
      <GestureHandlerRootView style={styles.terminalFrame}>
        <GestureDetector gesture={paneSwipe}>
          <View style={styles.terminalSurface}>
            <TerminalPaneView
              handle={active?.id ?? 'pane'}
              active
              // Still zero after M3, and now on purpose rather than for want of a keyboard: this lift
              // slides the *terminal* to keep a caret above the keyboard (orca `:4205-4211`), and M3's
              // keyboard problem was the input bar, which now clears the keyboard by itself
              // (`src/session/PaneInputBar.tsx`). Sliding the pane as well would hide its top rows
              // behind the header and needs `onKeyboardAvoidanceMetrics` — the caret row — which is
              // still dropped below. Left as a caret-visibility residual, not a hittability one.
              keyboardLift={0}
              textScale={1}
              onRef={(_handle, ref) => {
                handleRef.current = ref
              }}
              // Everything below is a write path or a gesture this milestone does not consume. They are
              // wired to no-ops rather than removed so `TerminalPaneView` stays as close to orca as
              // it can (one prop apart now, see its header) and M3 has only to fill them in.
              onWebReady={NOOP}
              onSelectionMode={NOOP}
              onSelectionCopy={NOOP}
              onSelectionEvicted={NOOP}
              onModesChanged={NOOP}
              onKeyboardAvoidanceMetrics={NOOP}
              onHaptic={NOOP}
              onTerminalInput={onTerminalInput}
              onTerminalQueryReply={NOOP}
              onTerminalTap={NOOP}
              onFileTap={NOOP}
              onOpenUrl={NOOP}
              onTextScaleChange={NOOP}
              // iOS only, and the asymmetry is the design. On Android RNGH takes the gesture at
              // the native layer and `paneSwipe` above already switches panes (184ms, measured on
              // emulator-5554); the document still posts its `pane-swipe` message there, and this
              // `undefined` is what makes RN drop it. Wiring both would let one finger count twice
              // — the recognizer switching on `onEnd` and the page switching again on touchend —
              // and a double switch lands two panes away from the one the reader aimed at.
              //
              // On iOS the recognizer never receives a touchesMoved at all (eight rounds, always
              // dx=0, `.prd/09-review-followups.md` §JJ), so this is the only live path.
              onPaneSwipe={Platform.OS === 'ios' ? onPaneSwipe : undefined}
            />
          </View>
        </GestureDetector>
      </GestureHandlerRootView>

      {/* .prd/11 ② — the mockup's `agentline` (`assets/mockup.html:587`): dot, who, state, and the
          connection reading, *below* the terminal rather than crammed into the top bar.
          Three device rounds measured that bar overflowing: at 2차 the node name was in it twice
          and `observing` hard-cut at x=1079; removing the duplicate slot let `observing` through
          and the 3차 round measured the *next* item (`Connected`) cut at the same x, with nine
          scanlines touching the bezel while every other screen stopped at x≤1035. Taking one item
          out of a row that is over budget only moves which item is lost — the mockup's answer is
          that this chain was never supposed to be up there. */}
      <View style={styles.agentLine}>
        {activePane ? <AgentStateDot state={activePane.agent_status} /> : null}
        {activePane ? (
          <Text style={styles.agentLineText} numberOfLines={1}>
            {agentStateLabel({
              agent_status: activePane.agent_status,
              state_labels: activePane.state_labels
            })}
          </Text>
        ) : null}
        <Text style={styles.agentLineText} numberOfLines={1}>
          {streamSummary(observer.status, observer.error, connection !== null)}
        </Text>
        <ConnectionStatusLine status={connectionStatus} />
      </View>

      <PaneInputBar input={input} />

      {/* Last child, so it covers the terminal and the input bar without either being unmounted:
          the observe stream, the ssh channel and the xterm document all stay exactly as they were
          while history is on screen (§Q's re-attach receipts depend on nothing here changing). It
          renders `null` while closed. */}
      <PaneHistoryOverlay
        history={history}
        paneLabel={activePane ? paneTitle(activePane) : (active?.handle ?? paneId ?? 'Pane')}
        // The identical expression the header above is padded by, and deliberately not a second
        // call: the overlay covers that header, so the two bars are one bar in two states.
        topPadding={safeChromePadding(insets.top, HEADER_TOP_PADDING)}
      />
    </View>
  )
}

/** One shared no-op so the props below do not allocate a closure per render (`react-perf`). */
const NOOP = () => {}

// expo-router needs a default export per route file; the named export above is what a caller that
// owns navigation (the master-detail layout, and the tests) mounts. Same split as
// `app/h/[remoteId]/index.tsx`, which is orca's (`app/h/[hostId]/index.tsx`).
export default function PaneViewerRoute() {
  const { remoteId, paneId } = useLocalSearchParams<{ remoteId?: string; paneId?: string }>()
  const router = useRouter()
  // `setParams`, not `replace` — and this line is N2, the largest measured defect in the viewer.
  //
  // `[paneId]` is a dynamic segment, so `replace` to a different pane is a *different route*: the
  // screen unmounts and a new one mounts, taking the 730KB xterm document with it. Measured cost of
  // that rebuild: 523–731ms on iOS and, on Android, up to 3s of blank plus 15s to content on a pane
  // with a deep buffer — while the swipe itself is ~180ms on both. The gesture was never the
  // problem.
  //
  // `setParams` merges into the focused route (`expo-router/build/global-state/routing.js:174`,
  // which forwards to React Navigation's own `setParams`), so the URL still names the pane — Back,
  // a deep link and a notification tap (`src/notifications/pane-deep-link.ts`) all restore from it
  // exactly as before — while this component instance, and therefore the document, survives. The
  // observer retargets on the same stream it already had (`src/session/use-pane-observer.ts`),
  // which is what §2.3 always intended: only the document was being thrown away.
  //
  // Still not `push`, for the original reason: a chip is a lateral move inside one viewer, so Back
  // should return to the workspace browser rather than walk a stack of panes nobody meant to build.
  const select = useCallback((next: string) => router.setParams({ paneId: next }), [router])
  return <PaneViewerScreen remoteId={remoteId} paneId={paneId} onSelectPane={select} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  // No `paddingTop`: it is the inset's, above.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 8,
    paddingHorizontal: 16
  },
  title: { color: mono.fg, fontSize: 15, fontWeight: '700', fontFamily: typography.monoFamily },
  subtitle: { color: mono.fgSoft, fontSize: 12, flexShrink: 1, fontFamily: typography.monoFamily },
  meta: { color: mono.dim, fontSize: 11, marginLeft: 8, fontFamily: typography.monoFamily },
  // The mockup's `agentline` (:587, `.agentline` at :169-ish): one row under the terminal, dim,
  // items separated by their own spacing rather than by a literal `·` so a missing item leaves no
  // orphan separator. `flexShrink` on the texts is what keeps this row from repeating the header's
  // failure — the reading that runs long gives up width instead of the row running off the bezel.
  agentLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6
  },
  agentLineText: {
    color: mono.dim,
    fontSize: 11,
    flexShrink: 1,
    fontFamily: typography.monoFamily
  },
  spacer: { flex: 1 },
  back: { paddingRight: 6 },
  backLabel: { color: mono.fgSoft, fontSize: 13, fontFamily: typography.monoFamily },
  node: { color: mono.fgSoft, fontSize: 12, fontFamily: typography.monoFamily },
  headerAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: mono.line,
    borderRadius: 4,
    backgroundColor: mono.ink2
  },
  // Monotone has no "disabled" hue, so the affordance dims down the ramp instead.
  headerActionDisabled: { opacity: 0.4 },
  headerActionLabel: {
    color: mono.fg,
    fontSize: 11,
    fontWeight: '600',
    fontFamily: typography.monoFamily
  },
  chipBar: { borderBottomWidth: 1, borderBottomColor: mono.line },
  chipContent: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: mono.line,
    backgroundColor: mono.ink2
  },
  chipActive: { borderColor: mono.fgSoft, backgroundColor: mono.ink3 },
  chipLabel: { color: mono.fg, fontSize: 12, fontWeight: '600', fontFamily: typography.monoFamily },
  chipTab: { color: mono.dim2, fontSize: 10, fontFamily: typography.monoFamily },
  terminalFrame: { flex: 1, backgroundColor: mono.ink },
  terminalSurface: { flex: 1 }
})
