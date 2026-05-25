# AGENTS.md - Machine-Readable Package Documentation

## Package Identity

- **Name:** `@marianmeres/connection-monitor`
- **Version:** 1.0.0
- **License:** MIT
- **Repository:** https://github.com/marianmeres/connection-monitor
- **NPM:** https://www.npmjs.com/package/@marianmeres/connection-monitor
- **JSR:** https://jsr.io/@marianmeres/connection-monitor

## Purpose

Reactive, framework-agnostic browser connection-quality monitor. Reports a
numeric 0..5 verdict plus the latency / jitter / loss metrics behind it.
Active probing is the source of truth; an optional `PerformanceObserver`
augments the rolling window with passive samples from real traffic.

The public API is a single Svelte-store-compatible `subscribe` contract —
that is the only framework bridge. No adapter layer for any specific
framework; consumers wire it into whatever store/reactive system they prefer.

## Core Concepts

### Reactive store

`createConnectionMonitor()` returns a monitor whose `subscribe(cb)` follows
the Svelte store contract: `cb` is invoked immediately with the current
status, and again on every subsequent change. The status object carries both
the quality verdict and the lifecycle `running` flag, so a single
subscription drives a complete UI.

Internally, status changes are routed through a `@marianmeres/pubsub`
instance. The subscribe wrapper adds the Svelte-style immediate call.

### Quality is numeric (0..5)

Reasoning: text labels like `"weak"` and `"bad"` are unordered by inspection.
Numeric values are unambiguous and compare naturally. Named constants
(`QUALITY.OFFLINE` … `QUALITY.EXCELLENT`) keep code readable.

### Active + passive measurement

- **Active probes** (always): periodic same-origin `GET` to a configurable
  endpoint. Cache-busted. Full RTT contributes to the window. Failures and
  timeouts are recorded as samples with `ok: false` (signal, not errors).
- **Passive observation** (opt-in): `PerformanceObserver` on `resource`
  entries. TTFB of accepted entries (non-cached, with valid timing) feeds the
  same window. When a healthy passive sample arrives within `interval / 2`
  ms, the next active probe is skipped.

### Logging policy

Only **lifecycle events** (`start`, `stop`), **quality transitions**, and
**subscriber errors** are logged. Individual probe failures are **never**
logged — they are the mechanism by which the monitor detects bad connections,
not exceptions. The logger interface matches `@marianmeres/clog`; no logger
is required (default is a no-op).

## File Structure

```
src/
├── mod.ts                          # Entry point, re-exports all public API
├── create-connection-monitor.ts    # Main factory + lifecycle wiring
├── create-passive-observer.ts      # PerformanceObserver wrapper (opt-in)
├── evaluate-quality.ts             # Pure samples → verdict + hysteresis
├── types.ts                        # All public types + Quality / QUALITY
└── is-browser.ts                   # SSR / PerformanceObserver guards
tests/
├── evaluate-quality.test.ts        # Pure-function unit tests (no mocks)
├── connection-monitor.test.ts      # Factory tests with injectable fetcher
└── connection-monitor-lifecycle.test.ts  # start/stop/subscribe semantics
```

## Public API

### Factory

| Function                            | Returns             | Description                                                |
| ----------------------------------- | ------------------- | ---------------------------------------------------------- |
| `createConnectionMonitor(options?)` | `ConnectionMonitor` | Main entry point.                                          |
| `createPassiveObserver(onSample)`   | `PassiveObserver`   | Standalone `PerformanceObserver` wrapper. Mostly internal. |

### Monitor methods

```typescript
interface ConnectionMonitor {
	subscribe(cb: (status: ConnectionStatus) => void): Unsubscriber;
	get(): ConnectionStatus;
	isRunning(): boolean;
	start(): ConnectionMonitor;
	stop(): ConnectionMonitor;
	probe(): Promise<void>;
}
```

### Types

```typescript
type Quality = 0 | 1 | 2 | 3 | 4 | 5;
type Source = "active" | "passive" | "offline";

interface ConnectionStatus {
	running: boolean;
	quality: Quality;
	avgRtt: number | null;
	jitter: number | null;
	lossRate: number;
	samples: number;
	lastSampleAt: number | null;
	source: Source;
}

interface Sample {
	ok: boolean;
	latency: number;
	source: "active" | "passive";
	timestamp: number;
}

interface Thresholds {
	veryPoor?: { avgRtt?: number; lossRate?: number };
	poor?: { avgRtt?: number; jitter?: number };
	fair?: { avgRtt?: number };
	good?: { avgRtt?: number; jitter?: number };
}

type Fetcher = (
	input: string,
	init: { signal: AbortSignal; cache: "no-store"; method: "GET" },
) => Promise<unknown>;
```

### Options

```typescript
interface ConnectionMonitorOptions {
	url?: string; // default "/ping"
	interval?: number; // default 5000ms
	timeout?: number; // default 3000ms
	windowSize?: number; // default 5
	pauseWhenHidden?: boolean; // default true
	autoStart?: boolean; // default true
	passive?: boolean; // default false
	hysteresis?: number; // default 0
	thresholds?: Thresholds; // default DEFAULT_THRESHOLDS
	logger?: Logger; // default no-op (createNoopClog)
	fetcher?: Fetcher; // default global fetch
}
```

### Constants

| Name                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `QUALITY`            | Named accessors for the 0..5 scale (frozen).                  |
| `QUALITY_LABEL`      | Reverse map `{ 0: "OFFLINE", ..., 5: "EXCELLENT" }` (frozen). |
| `DEFAULT_THRESHOLDS` | Default threshold mapping (frozen).                           |

### Pure helpers

| Function                                     | Description                                                     |
| -------------------------------------------- | --------------------------------------------------------------- |
| `evaluateQuality(samples, thresholds?)`      | Pure verdict from a sample window. No globals, no side effects. |
| `resolveThresholds(overrides?)`              | Merge partial overrides on top of `DEFAULT_THRESHOLDS`.         |
| `applyHysteresis(reported, fresh, n, state)` | Gate downgrades behind N consecutive observations.              |
| `createHysteresisState()`                    | Allocate a fresh hysteresis state object.                       |
| `isBrowser()`                                | SSR guard.                                                      |
| `hasPerformanceObserver()`                   | True if `PerformanceObserver` is defined.                       |

## Dependencies

- **Runtime:**
  - `@marianmeres/clog` (`jsr:@marianmeres/clog@^3.21.0`) — `Logger` type, `createNoopClog`.
  - `@marianmeres/pubsub` (`jsr:@marianmeres/pubsub@^3.0.0`) — internal change bus.
- **Dev/Test:** `@std/assert`, `@std/fs`, `@std/path`.

## Platform Support

- **Browser:** Full support. Active probing, visibility-pause, online/offline
  events, and (opt-in) `PerformanceObserver` all work.
- **Deno:** Imports cleanly. Active probing works (no `document`, so
  visibility/online-offline listeners are skipped). Passive observation
  no-ops.
- **Node.js:** Via npm package (built with dnt). Same caveats as Deno for
  browser-only features.
- **SSR:** Safe to import. All `window` / `document` / `navigator` /
  `PerformanceObserver` access is guarded.

## Implementation Details

### Probe serialization

Concurrent callers (the loop tick and a manual `.probe()`, for instance) are
serialized through a single `inFlightProbe` Promise. A second caller awaits
the in-flight probe rather than kicking off a parallel fetch. This prevents
duplicate samples and timer leaks during overlap.

### Stop cleanup

`stop()` performs full teardown:

1. `probeLoopActive = false` — prevents the next tick from running.
2. `clearTimeout(timerId)` — cancels the scheduled next probe.
3. Aborts every controller in `inFlightControllers` — the fetcher's promise
   rejects via the abort signal; the doProbe `finally` clears its abort
   timer; the `recordSample` short-circuits because `status.running` is now
   false.
4. Detaches `visibilitychange` / `online` / `offline` listeners.
5. Stops the passive observer if attached.
6. Publishes `{...status, running: false}` so subscribers see the flip.

After `stop()`, the monitor is fully inert and can be `start()`-ed again
without leftover state — except for samples (which are kept across
stop/start; only `OFFLINE` transitions clear the window).

### Adaptive cadence (passive)

When `passive: true`, an active probe is skipped if **all** of the following
hold at tick time:

- A passive sample has been recorded (`lastPassiveAt !== null`).
- The most recent sample in the window is the passive one.
- That passive sample's age is `< interval / 2`.
- Its latency is `≤ thresholds.fair.avgRtt`.

The next tick re-evaluates from scratch. This is the proposal's "lower probe
cadence when real traffic is flowing."

### Quality bucketing

`evaluateQuality()` walks worst-bucket-first and stops at the first match:

```
if (lossRate > thresholds.veryPoor.lossRate
    || avgRtt > thresholds.veryPoor.avgRtt)  -> VERY_POOR (1)
else if (avgRtt > thresholds.poor.avgRtt
    || jitter > thresholds.poor.jitter)      -> POOR (2)
else if (avgRtt > thresholds.fair.avgRtt)    -> FAIR (3)
else if (avgRtt > thresholds.good.avgRtt
    || jitter > thresholds.good.jitter
    || lossRate > 0)                         -> GOOD (4)
else                                         -> EXCELLENT (5)
```

`OFFLINE` (0) is set outside `evaluateQuality()`: either explicitly when
the browser's `offline` event fires, or as the empty-window default. The
polled `navigator.onLine` value is intentionally **not** consulted — it is
under-specified by WHATWG and lies in several real-world environments
(iframes, VPNs, headless browsers, some extensions).

### Hysteresis

`applyHysteresis(reported, fresh, n, state)` is invoked after each fresh
verdict. Upgrades (`fresh >= reported`) pass through and clear the pending
state. Downgrades increment a per-level counter; the downgrade is reported
only when the counter reaches `n`. A different worse level resets the
counter to 1.

## Common Patterns

### Minimal usage

```typescript
const monitor = createConnectionMonitor({ url: "/ping" });
const unsub = monitor.subscribe((s) => render(s));
```

### Wire subscribers before probing

```typescript
const monitor = createConnectionMonitor({ url: "/ping", autoStart: false });
monitor.subscribe(handleStatus);
monitor.start();
```

### Throttle features under poor connectivity

```typescript
monitor.subscribe((s) => {
	if (s.quality <= QUALITY.POOR) {
		deferNonEssentialFetches();
	} else {
		resumeNormalCadence();
	}
});
```

### Force an immediate refresh

```typescript
// e.g. on a "retry" button click
await monitor.probe();
```

## Logging Contract

The monitor accepts any `@marianmeres/clog` `Logger` (`{ debug, log, warn,
error }`). Emitted events:

| Event                                | Method  | Example                                        |
| ------------------------------------ | ------- | ---------------------------------------------- |
| Monitor started                      | `log`   | `monitor started (url=/ping, interval=5000ms)` |
| Monitor stopped                      | `log`   | `monitor stopped`                              |
| Quality transition (online ↔ online) | `log`   | `quality: 4 (GOOD) -> 2 (POOR) — avgRtt=720ms` |
| Went offline                         | `log`   | `connection offline`                           |
| Came back online                     | `log`   | `connection restored — quality: 4 (GOOD)`      |
| Subscriber callback threw            | `error` | `subscriber error: <message>`                  |

No `debug()` is ever emitted, and **individual probe failures are not
logged**.

## Constraints

- `interval` and `timeout` must be positive finite numbers. Values are not
  re-validated — pass sensible defaults.
- The `fetcher` implementation must respect the `signal` argument for proper
  timeout handling; otherwise `timeout` becomes advisory only.
- Status changes are published synchronously. Subscribers are invoked in
  registration order; errors are caught and routed to `logger.error` via the
  underlying `@marianmeres/pubsub` `onError` handler.
- The first subscribe-time call may throw from the user callback; that throw
  is caught and routed to `logger.error`, then subscription proceeds.

## Non-goals

- **No throughput / bandwidth sampling.** Bandwidth probes require a
  configured uncompressed payload endpoint, are noisy on small payloads, and
  cost real bandwidth on cellular. The package focuses on latency, jitter,
  and loss — the signals that actually drive UX decisions. If needed in the
  future, this could be added behind an opt-in `throughput: {...}` option
  without breaking the API.
- **No Chromium-only hints** (`navigator.connection.effectiveType`,
  `saveData`). The proposal correctly notes "these are never the truth." Adds
  API surface for marginal value.
- **No framework adapters.** The Svelte-store subscribe contract IS the
  framework bridge; consumers can wrap it for React/Vue/etc. trivially. No
  separate entry points (e.g. `./svelte`) are shipped.

## Testing

```bash
deno task test           # Run all tests
deno task test:watch     # Watch mode
deno check src/mod.ts    # Type-check
```

Coverage notes:

- `evaluate-quality.test.ts` — pure unit tests over the bucketing logic and
  hysteresis filter. No mocks, no globals.
- `connection-monitor.test.ts` — factory tests with an injectable `fetcher`
  to drive deterministic samples without touching the real network.
- `connection-monitor-lifecycle.test.ts` — start/stop/probe semantics,
  idempotency, hysteresis end-to-end, `Symbol.dispose` on the unsubscriber.

Not covered by unit tests (validated manually in a browser):

- Visibility-pause behavior (`document.hidden` handling).
- `online` / `offline` browser events.
- `PerformanceObserver` passive observation.

## Building for NPM

```bash
deno task npm:build      # Build to .npm-dist/
deno task npm:publish    # Build and publish
deno task rp             # Release patch + publish (jsr + npm)
deno task rpm            # Release minor + publish
```

## Manual Smoke (browser)

1. Serve a tiny HTML page that imports the package and calls
   `createConnectionMonitor({ url: "/ping" })` against an endpoint returning
   `204`.
2. Verify a quality value (>0) appears within one `interval`.
3. Toggle browser devtools' offline mode → expect `quality: 0` and
   `source: "offline"`.
4. Toggle back online → expect a real quality verdict within ~1 interval.
5. Switch tabs (background) → probing pauses; return → probing resumes.
6. With `passive: true`, navigate around the app and confirm `source`
   sometimes shows `"passive"` between probes.
