// Not from orca — orca's keyboard machinery (`computeActiveTerminalKeyboardLift`) answers a
// different question: how far to slide the *terminal* so the caret stays above the keyboard. This
// answers the one .prd/09-review-followups.md §BB asked: how tall is the keyboard right now, so the
// input bar can get out from under it.
//
// iOS only, and that is the load-bearing line. iOS lays the keyboard *over* the window and never
// resizes it, so nothing in a flex column moves on its own and the bar has to be shifted by hand.
// Android's window does resize — `android/app/src/main/AndroidManifest.xml:18` declares
// `windowSoftInputMode="adjustResize"` — so RN's own layout has already lifted the bar by the time
// any listener could fire, and shifting it again would move it a second keyboard-height up, off
// over the terminal. That is also the measurement: M3 passed 4/4 on Android with this bar exactly
// as it was, and failed on iOS only.
//
// `keyboardWillShow` / `keyboardWillHide`, not `keyboardWillChangeFrame`: the "will" pair animates
// with the keyboard rather than after it, and the frame event also fires *during* a dismissal with
// the keyboard's full height in it — reading that would leave the bar lifted for good if it ever
// arrived after the hide. A permanent offset is exactly what §BB requirement 2 forbids.
import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/** The soft keyboard's current height in points, 0 whenever it is down or does not overlay. */
export function useSoftKeyboardHeight(): number {
  const [height, setHeight] = useState(0)

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return
    }
    const shown = Keyboard.addListener('keyboardWillShow', (event) => {
      const next = event.endCoordinates.height
      setHeight(Number.isFinite(next) && next > 0 ? next : 0)
    })
    const hidden = Keyboard.addListener('keyboardWillHide', () => {
      setHeight(0)
    })
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])

  return height
}
