import { SERVER_MESSAGE_VARIANT_NAMES } from "./constants.js";
import { LayoutMismatchError, type ObservedTag } from "./errors.js";

/**
 * How many frames sharing **one** undecodable tag, with no `Terminal` behind them, condemn the
 * connection.
 *
 * ## Why a repeat of one tag, and not a count of undecodable frames
 *
 * A healthy mx server sends this codec plenty of frames it does not decode, so "some undecodable
 * frames" is the *normal* state and a threshold on the total would condemn every working
 * connection. What it does not send is the same non-`Terminal` tag over and over: every undecoded
 * variant reachable by an observing `TerminalAnsi` client is **event-driven** —
 * `Notify` (`src/server/headless.rs:1958`, `:2933`), `WindowTitle` (`:2073`),
 * `Clipboard` (`:2112`), `PrefixInputSource` (`:2120`), `ReloadSoundConfig` (`:2431`),
 * `Pong` (`:3049`, an answer to a ping this codec never sends) — and `MouseCapture` (`:3702`) is
 * gated on `is_full_app_client()`, which an observing client is not. None of them is a stream.
 *
 * The one variant that *could* stream is `Compressed` (11), and it cannot reach here:
 * `compress_server_message` is applied only on the semantic-frame branch
 * (`src/server/render_stream.rs:88`), never on the `TerminalAnsi` branch that produces `Terminal`
 * (`:113`) — stated outright in `src/protocol/wire_fixtures.rs:240-243`. So a `TerminalAnsi`
 * observer never sees a run of tag 11 either.
 *
 * ## Why 5
 *
 * The threshold only has to clear routine traffic in the window between `ObserveTerminal` and the
 * first `Terminal`, which the server produces on its first render pass for that client. Nothing
 * above repeats five times in that window. Going higher costs nothing *against the failure this
 * detects* — a skewed peer's terminal stream is the repeat, so the fifth frame is a few renders
 * away, not a design tradeoff — and five keeps a comfortable margin over the largest plausible
 * routine burst (a title change plus its follow-up, a clipboard write, a notification).
 *
 * The conjunct that carries most of the safety is not the number: it is **zero `Terminal` frames
 * decoded**. One decoded `Terminal` proves the peer's tag 13 is this codec's `Terminal`, and the
 * probe is off for the life of the connection.
 */
export const DEFAULT_LAYOUT_PROBE_REPEATS = 5;

export interface WireLayoutProbeOptions {
  /** Repeats of one tag that condemn the connection. Defaults to {@link DEFAULT_LAYOUT_PROBE_REPEATS}. */
  repeats?: number | undefined;
}

/**
 * Watches a server stream for the one thing `assertWelcomeAccepted` cannot see: that the peer's
 * *tags* are not this codec's tags.
 *
 * Pure bookkeeping — no bytes, no clock, no I/O — because the rule is the part that has to be
 * reviewable, and because the primary verdict must work on a host with no timers at all
 * ({@link TransportTimer} is injected, and a caller may not have one). The deadline arm
 * ({@link WireLayoutProbe.deadlineExpired}) is a *secondary* input its owner may or may not feed.
 *
 * Lifecycle, and each state's justification:
 *
 * - **disarmed until {@link WireLayoutProbe.arm}** — before `ObserveTerminal` the server has not
 *   been asked for a stream, so "no `Terminal` yet" is evidence of nothing.
 * - **armed** — undecodable tags accumulate; a repeat is a verdict.
 * - **settled, permanently, on the first {@link WireLayoutProbe.noteTerminal}** — a decoded
 *   `Terminal` answers the question the probe was asking. A later `ObserveTerminal` (a second pane
 *   on the same channel) cannot re-open it.
 *
 * ⚠️ The verdict is an **inference**; see {@link LayoutMismatchError} for exactly what it does and
 * does not establish.
 *
 * ## Its role changed when the ABI prelude landed (M0-a)
 *
 * This class was written as the strongest signal a client-side codec could produce, and its own
 * docs said so: *"the real solution is for the server to carry an ABI fingerprint … outside this
 * package"*. **That solution now exists** — `src/abi.ts`, checked by `ServerMessageChannel` before
 * a single frame is decoded — so this is no longer the primary detector and must not be read as
 * one.
 *
 * It is kept, deliberately, because the two ask different questions:
 *
 * | | question | evidence | when |
 * |---|---|---|---|
 * | `AbiMismatchError` (`src/abi.ts`) | what does the peer **claim** to be? | the peer's own prelude | before any decode |
 * | this probe | how does the peer **behave**? | frames that fail to decode | after `ObserveTerminal` |
 *
 * A claim and a behaviour can disagree, and the case where they do is precisely the one the
 * prelude is weakest at: a build that announces this exact ABI and then emits something else (a
 * locally patched enum, a proxy rewriting frames, a same-fingerprint collision). Against a plain
 * upstream server the probe should now never fire, because the prelude refuses that peer first —
 * if it *does* fire, the announcement was false, and that is worth an error of its own.
 */
export class WireLayoutProbe {
  private readonly repeats: number;
  private isArmed = false;
  private terminals = 0;
  private readonly counts = new Map<number, number>();
  private verdict: LayoutMismatchError | null = null;

  constructor(options: WireLayoutProbeOptions = {}) {
    const repeats = options.repeats ?? DEFAULT_LAYOUT_PROBE_REPEATS;
    if (!Number.isInteger(repeats) || repeats < 1) {
      throw new Error(
        `WireLayoutProbe repeats must be an integer >= 1, got ${typeof repeats} ${String(repeats)}`,
      );
    }
    this.repeats = repeats;
  }

  /** True while the probe is watching: `ObserveTerminal` sent, no `Terminal` decoded yet. */
  get armed(): boolean {
    return this.isArmed && this.terminals === 0 && this.verdict === null;
  }

  /** The verdict, once reached. `undefined` while the connection is still innocent. */
  get result(): LayoutMismatchError | undefined {
    return this.verdict ?? undefined;
  }

  /** Called when the client sends `ObserveTerminal` — the message that starts the stream. */
  arm(): void {
    if (this.terminals > 0 || this.verdict !== null) {
      return;
    }
    this.isArmed = true;
  }

  /**
   * Called when a `Terminal` frame **decoded**, whether or not it was delivered.
   *
   * Decoding is the proof, not delivery: a diff withheld because the screen is desynchronized
   * (`ServerMessageChannel`) still came off the wire as this codec's `Terminal`.
   */
  noteTerminal(): void {
    this.terminals += 1;
    this.isArmed = false;
  }

  /**
   * Called for each frame skipped as an unsupported variant, with its wire tag. Returns the verdict
   * the moment one tag reaches the threshold, and `null` every other time — including every call
   * after the first verdict, so the error is raised exactly once.
   */
  noteUndecodableTag(tag: number): LayoutMismatchError | null {
    if (!this.armed) {
      return null;
    }
    const count = (this.counts.get(tag) ?? 0) + 1;
    this.counts.set(tag, count);
    if (count < this.repeats) {
      return null;
    }
    return this.condemn();
  }

  /**
   * Called when the first-`Terminal` deadline expires, for an owner that has a timer.
   *
   * Secondary on purpose, and deliberately weaker than it could be: a skewed peer whose pane is
   * idle may send only one frame, which the repeat rule can never reach, so time is the only thing
   * that turns that into an answer. But a deadline with **no undecodable frame behind it** says
   * nothing about the layout — an idle pane, a wrong target, a busy server all look like that — so
   * it stays silent rather than inventing a diagnosis it has no evidence for.
   */
  deadlineExpired(): LayoutMismatchError | null {
    if (!this.armed || this.counts.size === 0) {
      return null;
    }
    return this.condemn();
  }

  /** Every undecodable tag seen while armed, most frequent first (ties by tag, for determinism). */
  observedTags(): ObservedTag[] {
    return [...this.counts.entries()]
      .map(([tag, count]) => ({
        tag,
        name: SERVER_MESSAGE_VARIANT_NAMES[tag],
        count,
      }))
      .sort((a, b) => (b.count - a.count) || (a.tag - b.tag));
  }

  private condemn(): LayoutMismatchError {
    const verdict = new LayoutMismatchError(this.observedTags(), this.terminals);
    this.verdict = verdict;
    this.isArmed = false;
    return verdict;
  }
}
