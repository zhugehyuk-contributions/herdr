// Not from orca. The app half of one contract that is written down on the desktop half and was,
// until this file, enforced on neither: the deep link a blocked-push notification carries.
//
// The producer is `plugins/herdr-blocked-push/sender/drain.py` (`build_payload`), and its shape is
// pinned in that plugin's `README.md#deep-link`:
//
//     herdr:///h/<remote_id>/pane/<pane_id>
//
// Three properties of that string are load-bearing and each one is a test below:
//
//  * **The empty authority (`:///`) is deliberate.** `herdr://h/x/pane/y` parses `h` as a *host* in
//    a strict URL parser and as a path segment in Expo's linking layer. `:///` means one thing
//    everywhere. This parser accepts the canonical form and, because a hand-written config or an
//    older sender can produce the other one, also accepts `herdr://h/...` — but it never accepts a
//    two-segment reading of the canonical form.
//  * **Both segments are percent-encoded.** herdr pane ids contain a colon (`w1:p1` → `w1%3Ap1`),
//    which is legal in a path and is exactly the character URL parsers disagree about. The route
//    (`app/h/[remoteId]/pane/[paneId].tsx`) is handed the *decoded* value, so the decode happens
//    here.
//  * **The href it produces is `paneHref`'s**, not a second spelling of the same route. The list
//    screen and the notification tap have to agree on the address of a pane, and one function is
//    how they cannot drift (`src/agents/fleet-agents.ts:80`).
//
// Why parse the URL at all when the record also carries `remote_id`/`pane_id` as data fields: the
// data fields are the fast path and the URL is the fallback. A notification that reaches the app
// through the OS's own URL handling (a `herdr://` link tapped anywhere else, or a payload whose
// `data` an Expo/APNs hop trimmed) still has the URL, and a notification built by an older sender
// may have the URL and nothing else.
import { paneHref } from '../agents/fleet-agents'

export const HERDR_SCHEME = 'herdr'

/** The pane a notification points at. Both fields are already percent-decoded. */
export interface PaneTarget {
  remoteId: string
  paneId: string
}

/**
 * Parses a `herdr:///h/<remote>/pane/<pane>` link.
 *
 * Returns `null` — never throws and never guesses — for anything else, including a `herdr://` URL
 * that names some other route. A tap that cannot be resolved to a pane must leave the user where
 * they were rather than navigate somewhere arbitrary.
 */
export function parsePaneDeepLink(url: unknown): PaneTarget | null {
  if (typeof url !== 'string') {
    return null
  }
  const trimmed = url.trim()
  const prefix = `${HERDR_SCHEME}:`
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return null
  }
  // Everything after the scheme, with the authority marker and any authority removed. Splitting on
  // `/` rather than using a URL parser is the point: RN's URL polyfill and Expo's linking layer
  // disagree about the authority of a `scheme:///path`, and this parser has to agree with both.
  let rest = trimmed.slice(prefix.length)
  if (rest.startsWith('//')) {
    rest = rest.slice(2)
    // `herdr://h/x/pane/y` — the non-canonical form. The first segment is the authority to a strict
    // parser and a path segment to a lenient one; accepting it here is what makes the two readings
    // land on the same pane instead of on nothing.
    if (!rest.startsWith('/')) {
      rest = `/${rest}`
    }
  }
  const [path] = rest.split(/[?#]/, 1)
  const segments = (path ?? '').split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 4 || segments[0] !== 'h' || segments[2] !== 'pane') {
    return null
  }
  const remoteId = decodeSegment(segments[1])
  const paneId = decodeSegment(segments[3])
  if (remoteId === null || paneId === null || remoteId === '' || paneId === '') {
    return null
  }
  return { remoteId, paneId }
}

/** The canonical link for a pane. The sender builds the same string in Python; this is the oracle. */
export function paneDeepLink(target: PaneTarget): string {
  return `${HERDR_SCHEME}:///h/${encodeURIComponent(target.remoteId)}/pane/${encodeURIComponent(target.paneId)}`
}

/** The in-app address of a pane target — `paneHref`, so the tap and the list agree. */
export function paneTargetHref(target: PaneTarget): string {
  return paneHref(target.remoteId, target.paneId)
}

/**
 * `decodeURIComponent` throws on a malformed escape (`%zz`), and a notification payload is data
 * that arrived from outside the program. Same treatment the wire gets in `src/api/`: parsed, not
 * asserted.
 */
function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) {
    return null
  }
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
