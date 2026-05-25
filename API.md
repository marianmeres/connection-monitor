# API Reference

Complete API documentation for `@marianmeres/connection-monitor`.

## Table of Contents

- [Factory Functions](#factory-functions)
  - [createConnectionMonitor](#createconnectionmonitoroptions-connectionmonitor)
  - [createPassiveObserver](#createpassiveobserveronsample-passiveobserver)
- [Interfaces](#interfaces)
  - [ConnectionMonitor](#connectionmonitor)
  - [ConnectionMonitorOptions](#connectionmonitoroptions)
  - [ConnectionStatus](#connectionstatus)
  - [Thresholds](#thresholds)
  - [ResolvedThresholds](#resolvedthresholds)
  - [Sample](#sample)
  - [PassiveObserver](#passiveobserver)
- [Types](#types)
  - [Quality](#quality)
  - [Source](#source)
  - [Fetcher](#fetcher)
- [Constants](#constants)
  - [QUALITY](#quality-constant)
  - [QUALITY_LABEL](#quality_label)
  - [DEFAULT_THRESHOLDS](#default_thresholds)
- [Helper Functions](#helper-functions)
  - [evaluateQuality](#evaluatequalitysamples-thresholds-qualityverdict)
  - [resolveThresholds](#resolvethresholdsoverrides-resolvedthresholds)
  - [applyHysteresis](#applyhysteresisreported-fresh-requiredconsecutive-state-quality)
  - [isBrowser](#isbrowser-boolean)
  - [hasPerformanceObserver](#hasperformanceobserver-boolean)

---

## Factory Functions

### `createConnectionMonitor(options?): ConnectionMonitor`

Creates a reactive connection-quality monitor.

**Signature:**

```typescript
createConnectionMonitor(options?: ConnectionMonitorOptions): ConnectionMonitor
```

**Parameters:**

See [`ConnectionMonitorOptions`](#connectionmonitoroptions) for the full
option table. All options are optional.

**Returns:** [`ConnectionMonitor`](#connectionmonitor)

**Examples:**

```typescript
import { createConnectionMonitor, QUALITY } from "@marianmeres/connection-monitor";

// Defaults: /ping, 5s interval, 3s timeout, window size 5, auto-starts.
const monitor = createConnectionMonitor();
monitor.subscribe((status) => console.log(status));

// Tighter cadence + passive augmentation + hysteresis.
const monitor = createConnectionMonitor({
	url: "/health",
	interval: 3000,
	timeout: 2000,
	passive: true,
	hysteresis: 2,
});

// Defer starting until subscribers are wired.
const monitor = createConnectionMonitor({ autoStart: false });
monitor.subscribe((s) => updateUi(s));
monitor.start();
```

---

### `createPassiveObserver(onSample): PassiveObserver`

Standalone wrapper around `PerformanceObserver` that watches `resource`
entries and emits cleaned TTFB samples. Mainly internal — use the
`passive: true` option on `createConnectionMonitor` for the normal case.

**Signature:**

```typescript
createPassiveObserver(onSample: (sample: Sample) => void): PassiveObserver
```

**Parameters:**

| Parameter  | Type                       | Description                                         |
| ---------- | -------------------------- | --------------------------------------------------- |
| `onSample` | `(sample: Sample) => void` | Invoked for every accepted sample (post-filtering). |

**Returns:** [`PassiveObserver`](#passiveobserver)

**Filtering rules:**

- Entries with `transferSize === 0` are skipped (typically memory-cache hits).
- Entries with non-positive `responseStart - requestStart` are skipped
  (cross-origin without `Timing-Allow-Origin` reports zeros).

In environments without `PerformanceObserver` (Node / SSR / older browsers),
returns a no-op handle so callers can wire it up unconditionally.

---

## Interfaces

### `ConnectionMonitor`

The reactive monitor returned by [`createConnectionMonitor`](#createconnectionmonitoroptions-connectionmonitor).

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

| Method          | Returns             | Description                                                                                                                                                                                                  |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subscribe(cb)` | `Unsubscriber`      | Subscribe to status changes. `cb` is invoked **immediately** with the current status (Svelte-store contract) and again on every change. Returns an idempotent unsubscriber that implements `Symbol.dispose`. |
| `get()`         | `ConnectionStatus`  | Returns the current status snapshot.                                                                                                                                                                         |
| `isRunning()`   | `boolean`           | Imperative getter for the `running` flag. Equivalent to `get().running`.                                                                                                                                     |
| `start()`       | `ConnectionMonitor` | (Re)start the probe loop and attach lifecycle listeners. No-op when already running.                                                                                                                         |
| `stop()`        | `ConnectionMonitor` | Stop the probe loop and detach all lifecycle listeners. Publishes a status with `running: false`. No-op when already stopped.                                                                                |
| `probe()`       | `Promise<void>`     | Trigger a single probe outside the normal cadence. Resolves when the probe completes (success or failure). No-op when stopped.                                                                               |

---

### `ConnectionMonitorOptions`

```typescript
interface ConnectionMonitorOptions {
	url?: string;
	interval?: number;
	timeout?: number;
	windowSize?: number;
	pauseWhenHidden?: boolean;
	autoStart?: boolean;
	passive?: boolean;
	hysteresis?: number;
	thresholds?: Thresholds;
	logger?: Logger;
	fetcher?: Fetcher;
}
```

| Option            | Type         | Default   | Description                                                                                                                               |
| ----------------- | ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `string`     | `"/ping"` | Same-origin endpoint. Ideally returns `204 No Content`. The package adds a cache-busting query param automatically.                       |
| `interval`        | `number`     | `5000`    | Probe cadence in milliseconds.                                                                                                            |
| `timeout`         | `number`     | `3000`    | Probe slower than this is recorded as failed.                                                                                             |
| `windowSize`      | `number`     | `5`       | Number of samples retained in the rolling window.                                                                                         |
| `pauseWhenHidden` | `boolean`    | `true`    | Pause probing while `document.hidden`. Resumes on visibility change.                                                                      |
| `autoStart`       | `boolean`    | `true`    | Start probing immediately on construction. Set `false` to wire subscribers first.                                                         |
| `passive`         | `boolean`    | `false`   | Augment the rolling window with `PerformanceObserver` samples from real Resource Timing entries. Browser-only; silently no-ops elsewhere. |
| `hysteresis`      | `number`     | `0`       | Require N consecutive samples in a worse bucket before downgrading the verdict. Upgrades and `OFFLINE` are always immediate.              |
| `thresholds`      | `Thresholds` | defaults  | Per-level threshold overrides; partial — any field left undefined falls back to [`DEFAULT_THRESHOLDS`](#default_thresholds).              |
| `logger`          | `Logger`     | no-op     | Logger conforming to `@marianmeres/clog`'s `Logger` interface. Only lifecycle and status-transition events are logged.                    |
| `fetcher`         | `Fetcher`    | `fetch`   | Injectable fetch implementation. Must respect `signal` for abort/timeout. Primarily for testing.                                          |

---

### `ConnectionStatus`

The reactive value subscribers receive.

```typescript
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
```

| Field          | Type             | Description                                                                       |
| -------------- | ---------------- | --------------------------------------------------------------------------------- |
| `running`      | `boolean`        | `true` while the probe loop is active. Flips on `start()` / `stop()`.             |
| `quality`      | `Quality`        | Verdict on the 0..5 scale. Compare with [`QUALITY`](#quality-constant) constants. |
| `avgRtt`       | `number \| null` | Rolling mean of successful-sample latencies, in ms. `null` if no samples yet.     |
| `jitter`       | `number \| null` | Mean absolute deviation of the latency window, in ms. `null` if no samples yet.   |
| `lossRate`     | `number`         | Fraction of failed/timed-out active probes in the window, 0..1.                   |
| `samples`      | `number`         | Number of samples currently in the rolling window.                                |
| `lastSampleAt` | `number \| null` | `performance.now()` timestamp of the most recent sample, or `null`.               |
| `source`       | `Source`         | Which producer fed the most recent sample.                                        |

---

### `Thresholds`

Partial overrides for the default quality thresholds. Any field left
undefined falls back to its [`DEFAULT_THRESHOLDS`](#default_thresholds) value.

```typescript
interface Thresholds {
	veryPoor?: { avgRtt?: number; lossRate?: number };
	poor?: { avgRtt?: number; jitter?: number };
	fair?: { avgRtt?: number };
	good?: { avgRtt?: number; jitter?: number };
}
```

Each level's condition is the **lower bound for entry into that level** —
e.g. `veryPoor.avgRtt = 1500` means "if `avgRtt > 1500`, the verdict is
`VERY_POOR` (or worse)". The verdict is computed worst-first and stops at the
first bucket that triggers.

---

### `ResolvedThresholds`

The fully-populated threshold shape returned by
[`resolveThresholds`](#resolvethresholdsoverrides-resolvedthresholds). Same
fields as [`Thresholds`](#thresholds) but with no optional leaves.

```typescript
interface ResolvedThresholds {
	veryPoor: { avgRtt: number; lossRate: number };
	poor: { avgRtt: number; jitter: number };
	fair: { avgRtt: number };
	good: { avgRtt: number; jitter: number };
}
```

---

### `Sample`

A single observation in the rolling window. Mostly internal but exposed for
custom samplers and tests.

```typescript
interface Sample {
	ok: boolean;
	latency: number;
	source: "active" | "passive";
	timestamp: number;
}
```

| Field       | Type                    | Description                                                              |
| ----------- | ----------------------- | ------------------------------------------------------------------------ |
| `ok`        | `boolean`               | `true` for successful responses, `false` for timeouts / network errors.  |
| `latency`   | `number`                | Active = full RTT; passive = TTFB.                                       |
| `source`    | `"active" \| "passive"` | Which producer recorded the sample.                                      |
| `timestamp` | `number`                | `performance.now()` (or `Date.now()` fallback) at the time of recording. |

---

### `PassiveObserver`

```typescript
interface PassiveObserver {
	stop(): void;
}
```

Returned by [`createPassiveObserver`](#createpassiveobserveronsample-passiveobserver).
`stop()` disconnects the underlying `PerformanceObserver` and is idempotent.

---

## Types

### `Quality`

Numeric union type for the connection-quality scale.

```typescript
type Quality = 0 | 1 | 2 | 3 | 4 | 5;
```

Use the [`QUALITY`](#quality-constant) constants for named comparisons.

---

### `Source`

```typescript
type Source = "active" | "passive" | "offline";
```

Reflects which producer fed the most recent sample, or `"offline"` when
the browser fired its `offline` event (or no samples have been collected
yet on first start).

---

### `Fetcher`

```typescript
type Fetcher = (
	input: string,
	init: { signal: AbortSignal; cache: "no-store"; method: "GET" },
) => Promise<unknown>;
```

Minimal fetch-like shape used to issue probes. Implementations must respect
`signal` for abort/timeout handling.

---

## Constants

### `QUALITY` (constant)

```typescript
const QUALITY: Readonly<{
	OFFLINE: 0;
	VERY_POOR: 1;
	POOR: 2;
	FAIR: 3;
	GOOD: 4;
	EXCELLENT: 5;
}>;
```

Named accessors for the [`Quality`](#quality) scale. Frozen.

---

### `QUALITY_LABEL`

```typescript
const QUALITY_LABEL: Readonly<Record<Quality, string>>;
```

Reverse mapping: `QUALITY_LABEL[0] === "OFFLINE"`, etc. Useful for logs,
tooltips, and telemetry.

---

### `DEFAULT_THRESHOLDS`

```typescript
const DEFAULT_THRESHOLDS: ResolvedThresholds = {
	veryPoor: { avgRtt: 1500, lossRate: 0.4 },
	poor: { avgRtt: 600, jitter: 300 },
	fair: { avgRtt: 250 },
	good: { avgRtt: 100, jitter: 60 },
};
```

The threshold values applied when the caller does not supply
[`Thresholds`](#thresholds) overrides. Frozen.

---

## Helper Functions

### `evaluateQuality(samples, thresholds?): QualityVerdict`

Pure computation of the verdict from a rolling sample window. No globals, no
side effects — easy to unit-test the bucketing logic without browser mocking.

**Signature:**

```typescript
evaluateQuality(
    samples: readonly Sample[],
    thresholds?: ResolvedThresholds,
): {
    quality: Quality;
    avgRtt: number | null;
    jitter: number | null;
    lossRate: number;
};
```

**Behavior:**

- Empty window → `OFFLINE` with `null` metrics and `lossRate: 0`.
- All-failed active window → `VERY_POOR` with `null` `avgRtt`/`jitter` and the
  computed `lossRate`.
- Otherwise: averages and jitter are computed over `ok` samples (both `active`
  and `passive`); `lossRate` is computed only over `active` samples.

---

### `resolveThresholds(overrides?): ResolvedThresholds`

Deep-merges partial [`Thresholds`](#thresholds) overrides on top of
[`DEFAULT_THRESHOLDS`](#default_thresholds). Any field left undefined falls
back to the default.

```typescript
import { resolveThresholds } from "@marianmeres/connection-monitor";

const t = resolveThresholds({ fair: { avgRtt: 150 } });
// t.fair.avgRtt   === 150
// t.poor.avgRtt   === 600  (default)
// t.veryPoor      === { avgRtt: 1500, lossRate: 0.4 } (default)
```

---

### `applyHysteresis(reported, fresh, requiredConsecutive, state): Quality`

Dampens flapping by requiring `requiredConsecutive` consecutive observations
of a worse-than-current bucket before applying the downgrade. Upgrades and
equal verdicts pass through immediately and clear the pending state.

**Signature:**

```typescript
applyHysteresis(
    reported: Quality,
    fresh: Quality,
    requiredConsecutive: number,
    state: HysteresisState,
): Quality;

interface HysteresisState {
    pendingCount: number;
    pendingLevel: Quality | null;
}

createHysteresisState(): HysteresisState;
```

The `state` argument is owned by the caller — pass it through unchanged on
each call. Use [`createHysteresisState()`](#applyhysteresisreported-fresh-requiredconsecutive-state-quality)
to create one.

---

### `isBrowser(): boolean`

Returns `true` when running in a real browser (window + document +
`globalThis === window`). False in Deno, Node, SSR, and Web Workers.

---

### `hasPerformanceObserver(): boolean`

Returns `true` when `PerformanceObserver` is defined. Used to short-circuit
passive observation in environments that lack the API.
