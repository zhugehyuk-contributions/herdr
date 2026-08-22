// Not from orca as a file — it is the **decomposed** port of orca's
// `app/h/[hostId]/session/[worktreeId].tsx`, which the port map forbids taking whole (§6 위험 2:
// "통째로 가져오면 herdr에 없는 RPC 수십 개를 함께 끌고 온다. 훅·순수함수 단위로만 뽑아라").
// That file is 5,333 lines; what is taken and what is left is recorded here rather than in a commit
// message, because the *omissions* are the design.
//
// Taken, by unit:
//   · `TerminalPaneView` (`src/session/TerminalPaneView.tsx`, 105 lines) — copied byte-identically
//     next to this file; the absolute-fill + `pointerEvents` + hidden-but-mounted structure and the
//     keyboard-lift transform are orca's.
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
//     it exists to keep a caret above a soft keyboard, and the lift needs the metrics stream plus a
//     measured layout this screen does not have. `keyboardLift` stays 0; the input bar is below the
//     terminal frame in normal flow, so it is the bar, not the caret, the keyboard meets first.
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
// One structural divergence from orca, deliberate: orca mounts **every** terminal and hides the
// inactive ones (`:4667` `terminals.map(...)`) so a tab switch is instant. Here exactly one pane is
// mounted, because a mounted pane is a resident ssh channel plus an uncompressed ANSI stream
// (blockers B8, B13) — N of those on LTE is not a background cost, it is the connection. The price
// is that switching re-handshakes, which is the <200ms target of milestone M6 (B6: herdr has no
// message to move an observe target, so even a warm channel could not retarget today).
import { useCallback, useMemo, useRef } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
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
import { paneHref } from '../../../../src/agents/fleet-agents'
import { usePaneObserver } from '../../../../src/session/use-pane-observer'
import { usePaneInput } from '../../../../src/session/use-pane-input'
import { PaneInputBar } from '../../../../src/session/PaneInputBar'
import { mono } from '../../../../src/theme/monotone'
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
  const remote = useRemote(remoteId)
  const entry = useRemoteSnapshot(remoteId)
  const connection = useHerdrConnection(remoteId)
  // M4/X4: the *supervisor*, not a link. `useConnectionStatus` re-reads it on every state change
  // through `useSyncExternalStore`, so this screen can never hold a link `forceReconnect` replaced.
  // Both are null in a build with no transport supervision, and the status line renders nothing.
  const supervised = useHerdrSupervisor(remoteId)
  const connectionStatus = useConnectionStatus(supervised)
  const handleRef = useRef<TerminalWebViewHandle | null>(null)

  const routed = entry?.panes.find((pane) => pane.pane_id === paneId) ?? null
  // Siblings = every pane of the *workspace*, across its tabs: 01-spec.md flattens the tab layer
  // into the viewer ("tab은 pane 그룹이므로 뷰어 안의 세그먼트로 평탄화한다"), so the strip spans
  // tabs and the tab survives only as each chip's label.
  const siblings = useMemo(
    () =>
      routed ? (entry?.panes ?? []).filter((pane) => pane.workspace_id === routed.workspace_id) : [],
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
    handleRef
  })
  // Targets the *active chip's* pane, exactly like the observer above, so the screen you are
  // reading and the pane you are typing into cannot drift apart. `usePaneInput` rebuilds its sender
  // when that id changes and drops anything unsent (`src/session/pane-input.ts`, `close`).
  const input = usePaneInput({ connection, paneId: active?.paneId ?? null })

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

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{active ? active.handle : (paneId ?? 'Pane')}</Text>
        {activePane ? <AgentStateDot state={activePane.agent_status} /> : null}
        <Text style={styles.subtitle} numberOfLines={1}>
          {activePane ? paneTitle(activePane) : (remote?.name ?? remoteId ?? '')}
        </Text>
        <View style={styles.spacer} />
        {activePane ? (
          <Text style={styles.meta}>
            {agentStateLabel({
              agent_status: activePane.agent_status,
              state_labels: activePane.state_labels
            })}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          {streamSummary(observer.status, observer.error, connection !== null)}
        </Text>
        <ConnectionStatusLine status={connectionStatus} />
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
                <Text style={styles.chipTab}>{chip.tabLabel}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.terminalFrame}>
        <TerminalPaneView
          handle={active?.id ?? 'pane'}
          active
          // Zero, and it stays zero for M2: the lift exists to keep a caret above a soft keyboard,
          // and a read-only viewer never opens one (orca `:4205-4211`). M3 fills it in.
          keyboardLift={0}
          textScale={1}
          onRef={(_handle, ref) => {
            handleRef.current = ref
          }}
          // Everything below is a write path or a gesture this milestone does not consume. They are
          // wired to no-ops rather than removed so `TerminalPaneView` stays byte-identical to orca
          // and M3 has only to fill them in.
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
        />
      </View>

      <PaneInputBar input={input} />
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
  // `replace`, not `push`: a chip is a lateral move inside one viewer, so Back should return to the
  // workspace browser rather than walk a stack of panes the user never meant to build.
  const select = useCallback(
    (next: string) => router.replace(paneHref(remoteId ?? '', next)),
    [remoteId, router]
  )
  return <PaneViewerScreen remoteId={remoteId} paneId={paneId} onSelectPane={select} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: mono.ink },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 16,
    paddingBottom: 8,
    paddingHorizontal: 16
  },
  title: { color: mono.fg, fontSize: 15, fontWeight: '700' },
  subtitle: { color: mono.fgSoft, fontSize: 12, flexShrink: 1 },
  meta: { color: mono.dim, fontSize: 11, marginLeft: 8 },
  spacer: { flex: 1 },
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
  chipLabel: { color: mono.fg, fontSize: 12, fontWeight: '600' },
  chipTab: { color: mono.dim2, fontSize: 10 },
  terminalFrame: { flex: 1, backgroundColor: mono.ink }
})
