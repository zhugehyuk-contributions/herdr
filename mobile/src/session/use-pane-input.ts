// Not from orca. The React half of `./pane-input.ts`, split for the same reason
// `./use-pane-observer.ts` is split from `./pane-observer.ts`: the single-flight/merge/verdict logic
// is the part worth testing, and it is testable without mounting anything (port map §3 P1 — "폰 없는
// 재현부터 돌려라, 실패하면 UI를 건드리지 마라").
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PaneInputSender,
  type PaneInputChunk,
  type PaneInputResult,
  type PaneInputState
} from './pane-input'
import type { HerdrRemoteConnection } from '../transport/herdr-connection'

export type PaneInputView = {
  state: PaneInputState
  /** True when a tap can be sent at all. False means every tap is refused on the spot (X2). */
  enabled: boolean
  send: (chunk: PaneInputChunk) => Promise<PaneInputResult>
  sendText: (text: string) => Promise<PaneInputResult>
  sendKeys: (keys: readonly string[]) => Promise<PaneInputResult>
}

export type UsePaneInputOptions = {
  /** Null when the remote is listed but not dialled. */
  connection: HerdrRemoteConnection | null
  paneId: string | null
}

const IDLE: PaneInputState = { last: null, inFlight: false, pendingChunks: 0 }

export function usePaneInput({ connection, paneId }: UsePaneInputOptions): PaneInputView {
  const [state, setState] = useState<PaneInputState>(IDLE)
  // A ref, not state: the sender must survive re-renders (its single-flight slot and its pending
  // merge are the whole point), and it is replaced only when the pane or the connection changes.
  const senderRef = useRef<PaneInputSender | null>(null)

  useEffect(() => {
    const sender = new PaneInputSender({
      api: connection?.api ?? null,
      paneId,
      onState: setState
    })
    senderRef.current = sender
    setState(IDLE)
    return () => {
      // Closing forgets whatever had not been sent. On a pane switch that is mandatory: a keystroke
      // aimed at pane A must never arrive at pane B, and herdr fixes the target at call time.
      sender.close()
      senderRef.current = null
    }
  }, [connection, paneId])

  const send = useCallback(async (chunk: PaneInputChunk): Promise<PaneInputResult> => {
    const sender = senderRef.current
    if (sender === null) {
      return { delivery: 'rejected', reason: 'no_transport' }
    }
    return sender.send(chunk)
  }, [])

  const sendText = useCallback((text: string) => send({ text, keys: [] }), [send])
  const sendKeys = useCallback((keys: readonly string[]) => send({ text: '', keys }), [send])

  const enabled = connection !== null && paneId !== null

  return useMemo(
    () => ({ state, enabled, send, sendText, sendKeys }),
    [enabled, send, sendKeys, sendText, state]
  )
}
