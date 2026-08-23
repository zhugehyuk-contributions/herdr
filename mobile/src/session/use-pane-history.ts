// Not from orca. The React half of `./pane-history.ts`, split for the same reason
// `./use-pane-observer.ts` is split from `./pane-observer.ts` and `./use-pane-input.ts` from
// `./pane-input.ts`: the caching / single-flight / verdict logic is the part worth testing and it is
// testable without mounting anything (port map §3 P1 — "폰 없는 재현부터 돌려라, 실패하면 UI를
// 건드리지 마라").
//
// What this half owns that the reader cannot: **when the surface is open**, and the rule that a pane
// change closes it. That rule is B8 again — following a swipe with a fresh read would put an ssh
// exec on the gesture the user makes most often — and it is also honest, because a history overlay
// left open across a switch would be showing pane A's scrollback over pane B's live screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PaneHistoryReader, type PaneHistorySnapshot } from './pane-history'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

export type PaneHistoryStatus = 'idle' | 'loading' | 'ready' | 'failed'

export type PaneHistoryView = {
  /** True while the overlay is on screen. The live pane keeps streaming underneath it either way. */
  visible: boolean
  status: PaneHistoryStatus
  snapshot: PaneHistorySnapshot | null
  error: string | null
  /** True when a press can open the surface at all — a remote must be dialled and a pane resolved. */
  enabled: boolean
  open: () => void
  close: () => void
  /** The only affordance that spends a second exec on a pane, and only from a user press. */
  refresh: () => void
}

export type UsePaneHistoryOptions = {
  /** Null when the remote is listed but not dialled. Every open then fails rather than hanging. */
  connection: HerdrRemoteConnection | null
  paneId: string | null
}

export function usePaneHistory({ connection, paneId }: UsePaneHistoryOptions): PaneHistoryView {
  const [visible, setVisible] = useState(false)
  const [status, setStatus] = useState<PaneHistoryStatus>('idle')
  const [snapshot, setSnapshot] = useState<PaneHistorySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Keyed by connection, not by pane: the cache has to survive pane switches, which is most of the
  // point of having one. A new transport is a new box's state, so it starts empty.
  const reader = useMemo(
    () => new PaneHistoryReader({ api: connection?.api ?? null }),
    [connection]
  )
  // Generation counter so a read that lands after the surface closed, or after the pane changed,
  // cannot write itself onto the screen.
  const generationRef = useRef(0)

  useEffect(() => {
    // A pane change closes the surface and forgets what is displayed; the *cache* is untouched, so
    // coming back to this pane is still free.
    generationRef.current += 1
    setVisible(false)
    setStatus('idle')
    setSnapshot(null)
    setError(null)
  }, [paneId, reader])

  const load = useCallback(
    (refresh: boolean) => {
      generationRef.current += 1
      const generation = generationRef.current
      // The cache read is synchronous and deliberately happens before any state churn: re-opening a
      // pane already read must not flash a spinner, because there is nothing to wait for.
      const cached = refresh ? null : reader.peek(paneId)
      if (cached !== null) {
        setSnapshot(cached)
        setStatus('ready')
        setError(null)
        return
      }
      setStatus('loading')
      setError(null)
      void reader
        .read(paneId, { refresh })
        .then((next) => {
          if (generationRef.current !== generation) {
            return
          }
          setSnapshot(next)
          setStatus('ready')
        })
        .catch((cause: unknown) => {
          if (generationRef.current !== generation) {
            return
          }
          setStatus('failed')
          setError(cause instanceof Error ? cause.message : String(cause))
        })
    },
    [paneId, reader]
  )

  const open = useCallback(() => {
    setVisible(true)
    load(false)
  }, [load])

  const close = useCallback(() => {
    // Bumping the generation here is what makes closing free: an exec still in flight resolves into
    // the cache (the reader owns that) but never into this state.
    generationRef.current += 1
    setVisible(false)
  }, [])

  const refresh = useCallback(() => {
    load(true)
  }, [load])

  const enabled = connection !== null && paneId !== null

  return useMemo(
    () => ({ visible, status, snapshot, error, enabled, open, close, refresh }),
    [close, enabled, error, open, refresh, snapshot, status, visible]
  )
}
