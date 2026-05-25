import type { Logger } from "@marianmeres/clog";
import type { Unsubscriber } from "@marianmeres/pubsub";

export type { Logger, Unsubscriber };

/**
 * Numeric connection-quality scale, ordered from worst (0) to best (5).
 * Use the exported {@link QUALITY} constants for readable comparisons.
 */
export type Quality = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Named constants for the {@link Quality} scale.
 *
 * The values are ordered, so callers can compare numerically:
 * ```ts
 * if (status.quality <= QUALITY.POOR) showWarning();
 * if (status.quality === QUALITY.OFFLINE) showOfflineBanner();
 * ```
 */
export const QUALITY: Readonly<{
	OFFLINE: 0;
	VERY_POOR: 1;
	POOR: 2;
	FAIR: 3;
	GOOD: 4;
	EXCELLENT: 5;
}> = Object.freeze({
	OFFLINE: 0,
	VERY_POOR: 1,
	POOR: 2,
	FAIR: 3,
	GOOD: 4,
	EXCELLENT: 5,
} as const);

/**
 * Optional human-readable labels for each {@link Quality} level. Exposed for
 * loggers, telemetry, and quick UI tooltips. Not part of the status object —
 * compose at the call site if needed.
 */
export const QUALITY_LABEL: Readonly<Record<Quality, string>> = Object.freeze({
	0: "OFFLINE",
	1: "VERY_POOR",
	2: "POOR",
	3: "FAIR",
	4: "GOOD",
	5: "EXCELLENT",
});

/**
 * Source of the most recent sample in the rolling window.
 *
 * - `"active"`: produced by the periodic same-origin probe.
 * - `"passive"`: produced by the optional `PerformanceObserver` observing
 *   real Resource Timing entries.
 * - `"offline"`: the browser fired its `offline` event (or no samples have
 *   been collected yet on first start).
 */
export type Source = "active" | "passive" | "offline";

/**
 * A single sample contributing to the rolling window.
 */
export interface Sample {
	/** Whether the sample reflects a successful response. Failed/timed-out
	 * active probes are recorded with `ok: false` and `latency: timeout`. */
	ok: boolean;
	/** Latency in milliseconds. Active = full RTT; passive = TTFB. */
	latency: number;
	/** Source that produced this sample. */
	source: "active" | "passive";
	/** `performance.now()` (or `Date.now()` fallback) timestamp when recorded. */
	timestamp: number;
}

/**
 * Per-level entry thresholds, applied worst-bucket-first. A sample falls into
 * the first level whose condition it triggers; if none triggers, it lands in
 * `EXCELLENT` (which additionally requires `lossRate === 0`).
 *
 * Partial overrides are merged on top of the defaults — you can override just
 * one number without re-specifying the rest. See the README for the default
 * mapping.
 */
export interface Thresholds {
	/** `VERY_POOR` (1): triggered by `avgRtt > .avgRtt` OR `lossRate > .lossRate`. */
	veryPoor?: { avgRtt?: number; lossRate?: number };
	/** `POOR` (2): triggered by `avgRtt > .avgRtt` OR `jitter > .jitter`. */
	poor?: { avgRtt?: number; jitter?: number };
	/** `FAIR` (3): triggered by `avgRtt > .avgRtt`. */
	fair?: { avgRtt?: number };
	/** `GOOD` (4): triggered by `avgRtt > .avgRtt` OR `jitter > .jitter`. */
	good?: { avgRtt?: number; jitter?: number };
}

/**
 * The monitor's reactive state. Subscribers receive a fresh `ConnectionStatus`
 * immediately on subscribe (Svelte-store contract) and on every subsequent
 * change.
 */
export interface ConnectionStatus {
	/** `true` while the probe loop is active. Flips on `start()` / `stop()`. */
	running: boolean;
	/** Current quality verdict, 0..5. Use {@link QUALITY} constants to compare. */
	quality: Quality;
	/** Rolling mean of successful-sample latencies, in ms. `null` if no samples yet. */
	avgRtt: number | null;
	/** Mean absolute deviation of the latency window, in ms. `null` if no samples yet. */
	jitter: number | null;
	/** Fraction of failed/timed-out active probes in the window, 0..1. */
	lossRate: number;
	/** Number of samples currently in the rolling window. */
	samples: number;
	/** `performance.now()` timestamp of the most recent sample, or `null`. */
	lastSampleAt: number | null;
	/** Which producer fed the most recent sample. */
	source: Source;
}

/**
 * Minimal fetch-like shape used to issue probes. The default implementation
 * calls the global `fetch`; tests inject a deterministic stub.
 *
 * The implementation must respect `signal` for abort/timeout handling.
 */
export type Fetcher = (
	input: string,
	init: { signal: AbortSignal; cache: "no-store"; method: "GET" },
) => Promise<unknown>;

/**
 * Options accepted by {@link createConnectionMonitor}. All fields are optional
 * — the defaults are tuned for a typical UI status indicator.
 */
export interface ConnectionMonitorOptions {
	/**
	 * Same-origin endpoint that returns a small response (ideally `204 No
	 * Content`). Cache-busted automatically. Defaults to `"/ping"`.
	 */
	url?: string;
	/** Probe cadence in milliseconds. Defaults to `5000`. */
	interval?: number;
	/** A probe slower than this is recorded as failed. Defaults to `3000`. */
	timeout?: number;
	/** Rolling sample window size. Defaults to `5`. */
	windowSize?: number;
	/** Stop probing while `document.hidden`. Defaults to `true`. */
	pauseWhenHidden?: boolean;
	/** Begin probing immediately on construction. Defaults to `true`. */
	autoStart?: boolean;
	/**
	 * Opt in to a `PerformanceObserver` that augments the rolling window with
	 * TTFB samples from real Resource Timing entries. Defaults to `false`.
	 */
	passive?: boolean;
	/**
	 * Require N consecutive samples in a worse bucket before downgrading the
	 * verdict. Prevents UI flapping; recommended `1..3` for indicators.
	 * Defaults to `0` (no hysteresis).
	 */
	hysteresis?: number;
	/** Per-level threshold overrides. Merged on top of the defaults. */
	thresholds?: Thresholds;
	/**
	 * Optional logger conforming to the `@marianmeres/clog` `Logger` interface.
	 * Only lifecycle events, quality transitions, and subscriber errors are
	 * logged — never individual probe failures (those are signal, not errors).
	 * Defaults to a no-op logger.
	 */
	logger?: Logger;
	/**
	 * Inject a custom fetch implementation. Primarily for testing — the default
	 * uses the global `fetch`.
	 */
	fetcher?: Fetcher;
}

/**
 * Reactive network-quality monitor returned by {@link createConnectionMonitor}.
 */
export interface ConnectionMonitor {
	/**
	 * Subscribe to status changes. The callback is invoked **immediately** with
	 * the current status (Svelte-store contract), and again on every change —
	 * including `running` flipping on `start()` / `stop()`.
	 *
	 * The returned unsubscriber is idempotent and supports `Symbol.dispose`.
	 */
	subscribe(cb: (status: ConnectionStatus) => void): Unsubscriber;
	/** Returns the current status snapshot. */
	get(): ConnectionStatus;
	/** Imperative getter for the `running` flag. Equivalent to `get().running`. */
	isRunning(): boolean;
	/**
	 * Start (or restart) the probe loop and attach lifecycle listeners
	 * (visibility, online/offline, passive observer). Safe to call when already
	 * running — it's a no-op in that case.
	 */
	start(): ConnectionMonitor;
	/**
	 * Stop the probe loop and detach all lifecycle listeners. The current
	 * status is published with `running: false` so subscribers can react.
	 * Safe to call when already stopped.
	 */
	stop(): ConnectionMonitor;
	/**
	 * Trigger a single probe immediately, outside the normal cadence. Useful
	 * for "refresh now" buttons. Resolves when the probe completes (success or
	 * failure). No-op when stopped.
	 */
	probe(): Promise<void>;
}
