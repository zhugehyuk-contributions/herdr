/**
 * A timer that is not there must say so.
 *
 * Every deadline in `src/transport.ts` is armed through a {@link TransportTimer}, and the default
 * one forwards to `globalThis`. It used to forward *optionally* — `host.setTimeout?.(…)` — so on a
 * host without timers the call became a no-op that returned `undefined`, the promise it was
 * supposed to bound was never bounded, and the documented 15s timeout became an unbounded wait.
 *
 * That degradation stopped being survivable when `JsonApiEventStream.subscribe` started waiting
 * for the server's acknowledgement: with no timer, `subscribe()` never settles. A pending promise
 * is the one failure mode with no diagnosis at all — no error, no log, no close — so the missing
 * capability is now reported where it is discovered.
 */
import { describe, expect, it } from "vitest";

import {
  JsonApiEventStream,
  createHostTimer,
  createTransportJsonApiClient,
  hostTimer,
} from "../src/index.js";
import { FakeTransport } from "./fakeTransport.js";

/** A host that has no timer API at all — React Native before `JSTimers` is installed, say. */
const TIMERLESS = createHostTimer({});

describe("hostTimer", () => {
  it("works on a host that has timers", () => {
    const handle = hostTimer.setTimeout(() => {}, 60_000);
    expect(handle).toBeDefined();
    expect(() => hostTimer.clearTimeout(handle)).not.toThrow();
  });

  it("fails loudly on a host with no timers, naming the injection point", () => {
    expect(() => TIMERLESS.setTimeout(() => {}, 15_000)).toThrow(/TransportTimer/);
  });

  /**
   * `setTimeout` without `clearTimeout` is worse than neither: the deadline arms, the read
   * succeeds, the timer cannot be cancelled, and it fires later on a *healthy* channel — failing
   * it with "no API response line" long after the response arrived. Both halves or nothing.
   */
  it("fails when the host has setTimeout but no clearTimeout", () => {
    const halfTimer = createHostTimer({ setTimeout: () => 1 });
    expect(() => halfTimer.setTimeout(() => {}, 15_000)).toThrow(/clearTimeout/);
  });

  it("tolerates clearing on a timerless host (nothing was ever armed)", () => {
    expect(() => TIMERLESS.clearTimeout(undefined)).not.toThrow();
  });
});

describe("a timerless host does not hang", () => {
  it("rejects an events.subscribe instead of waiting forever for the acknowledgement", async () => {
    const transport = new FakeTransport();

    await expect(
      JsonApiEventStream.subscribe(transport, [{ type: "pane.updated" }], () => {}, "ts-events", {
        timer: TIMERLESS,
      }),
    ).rejects.toThrow(/TransportTimer/);
    // …and does not leak the channel it opened.
    expect(transport.last().closed).toBe(true);
  });

  it("rejects a JSON API request instead of waiting forever for its response line", async () => {
    const transport = new FakeTransport();
    const api = createTransportJsonApiClient(transport, { timer: TIMERLESS });

    await expect(api.paneList()).rejects.toThrow(/TransportTimer/);
  });
});
