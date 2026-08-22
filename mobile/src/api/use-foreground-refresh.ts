// Not from orca. orca's screens are pushed to over a live WebSocket, so it has nothing to poll and
// no hook to port; herdr v1 has the opposite constraint. `events.subscribe` carries no sequence and
// replays its whole ring on every reconnect, so a phone that reconnects constantly never reaches
// live (.prd/03-blockers.md B9) — and B9's own resolution is explicit: "해소 전까지 v1은 구독 대신
// `agent.list` 폴링(포그라운드 3–5초)으로 간다."
//
// What it buys, measured: on a device the server flipped an agent `working` → `blocked` and the app
// still showed the old row 20+ seconds later, because the snapshot was loaded once at mount and
// nothing ever asked again (`./snapshot-context.tsx` had `reload` and zero callers). 04-milestones.md
// M2 (a) is "blocked를 Agents 홈에서 60초 내 발견"; a 4s foreground poll is what makes that a
// property of the app rather than of when the user happened to open it.
//
// Why the polling lives here and not in a screen: every screen reads one shared snapshot, so a
// per-screen timer would multiply ssh execs by the number of mounted screens for identical data.
import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useHerdrSnapshot } from './snapshot-context'

/** Middle of B9's 3–5s band: fast enough for M2 (a), slow enough that one exec answers before the next. */
export const FOREGROUND_REFRESH_MS = 4000

export function useForegroundRefresh(intervalMs: number = FOREGROUND_REFRESH_MS) {
  const { refresh } = useHerdrSnapshot()
  // Why through a ref: `refresh` changes identity whenever the loader does (a remote connects), and
  // a `refresh` dependency below would tear down and rebuild the interval on each such change —
  // which, if the identity ever churned per render, would silently mean the timer never fires.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const start = () => {
      if (timer !== null) {
        return
      }
      timer = setInterval(() => {
        void refreshRef.current()
      }, intervalMs)
    }
    if (AppState.currentState === 'active') {
      start()
    }
    // Why stop on background rather than let it run: the OS suspends and un-suspends JS timers on
    // its own schedule, so a backgrounded interval buys nothing and its wake-ups land as a burst of
    // ssh execs at resume. The listener is also the resume path — polling alone would leave the
    // returning user staring at up-to-`intervalMs`-old data, which is exactly the bug being fixed.
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') {
        void refreshRef.current()
        start()
        return
      }
      stop()
    })
    return () => {
      stop()
      subscription.remove()
    }
  }, [intervalMs])
}
