import { QUALITY, type Quality, type Sample, type Thresholds } from "./types.ts";

/**
 * Resolved threshold shape (no optional leaves). Returned by
 * {@link resolveThresholds} so consumers always work with a fully populated
 * object.
 */
export interface ResolvedThresholds {
	/** `VERY_POOR` (1): triggered by `avgRtt > .avgRtt` OR `lossRate > .lossRate`. */
	veryPoor: { avgRtt: number; lossRate: number };
	/** `POOR` (2): triggered by `avgRtt > .avgRtt` OR `jitter > .jitter`. */
	poor: { avgRtt: number; jitter: number };
	/** `FAIR` (3): triggered by `avgRtt > .avgRtt`. */
	fair: { avgRtt: number };
	/** `GOOD` (4): triggered by `avgRtt > .avgRtt` OR `jitter > .jitter`. */
	good: { avgRtt: number; jitter: number };
}

/**
 * Default threshold values. See AGENTS.md for the rationale behind each
 * number. Tune via the `thresholds` option on
 * `createConnectionMonitor` — partial overrides are deep-merged.
 */
export const DEFAULT_THRESHOLDS: ResolvedThresholds = Object.freeze({
	veryPoor: { avgRtt: 1500, lossRate: 0.4 },
	poor: { avgRtt: 600, jitter: 300 },
	fair: { avgRtt: 250 },
	good: { avgRtt: 100, jitter: 60 },
}) as ResolvedThresholds;

/**
 * Merges a partial {@link Thresholds} override on top of {@link DEFAULT_THRESHOLDS}.
 * Any field left undefined falls back to the default.
 */
export function resolveThresholds(
	overrides?: Thresholds,
): ResolvedThresholds {
	return {
		veryPoor: {
			avgRtt: overrides?.veryPoor?.avgRtt ?? DEFAULT_THRESHOLDS.veryPoor.avgRtt,
			lossRate: overrides?.veryPoor?.lossRate ??
				DEFAULT_THRESHOLDS.veryPoor.lossRate,
		},
		poor: {
			avgRtt: overrides?.poor?.avgRtt ?? DEFAULT_THRESHOLDS.poor.avgRtt,
			jitter: overrides?.poor?.jitter ?? DEFAULT_THRESHOLDS.poor.jitter,
		},
		fair: {
			avgRtt: overrides?.fair?.avgRtt ?? DEFAULT_THRESHOLDS.fair.avgRtt,
		},
		good: {
			avgRtt: overrides?.good?.avgRtt ?? DEFAULT_THRESHOLDS.good.avgRtt,
			jitter: overrides?.good?.jitter ?? DEFAULT_THRESHOLDS.good.jitter,
		},
	};
}

/**
 * Pure result of evaluating a rolling sample window. Combined with the
 * monitor's lifecycle state to produce a full `ConnectionStatus`.
 */
export interface QualityVerdict {
	/** Bucketed verdict, 0..5. Use {@link QUALITY} constants to compare. */
	quality: Quality;
	/** Rolling mean of successful-sample latencies, in ms. `null` if no samples. */
	avgRtt: number | null;
	/** Mean absolute deviation of the latency window, in ms. `null` if no samples. */
	jitter: number | null;
	/** Fraction of failed/timed-out active samples in the window, 0..1. */
	lossRate: number;
}

/**
 * Computes the quality verdict for a rolling sample window. Pure — no globals,
 * no side effects — so it's easy to unit-test the bucketing logic without any
 * browser/network mocking.
 *
 * The window may mix active and passive samples; both contribute to `avgRtt`
 * and `jitter`. Loss rate is computed only over *active* samples — passive
 * entries don't have a meaningful "failed" notion.
 *
 * Returns the `OFFLINE` verdict when the window is empty.
 */
export function evaluateQuality(
	samples: readonly Sample[],
	thresholds: ResolvedThresholds = DEFAULT_THRESHOLDS,
): QualityVerdict {
	if (samples.length === 0) {
		return { quality: QUALITY.OFFLINE, avgRtt: null, jitter: null, lossRate: 0 };
	}

	const activeAttempts = samples.filter((s) => s.source === "active");
	const lossRate = activeAttempts.length === 0
		? 0
		: 1 - activeAttempts.filter((s) => s.ok).length / activeAttempts.length;

	const okLatencies = samples.filter((s) => s.ok).map((s) => s.latency);
	if (okLatencies.length === 0) {
		// Every active probe failed and there are no passive samples — treat as
		// `VERY_POOR` rather than `OFFLINE` (offline is reserved for
		// `navigator.onLine === false` and is set by the monitor, not here).
		return {
			quality: QUALITY.VERY_POOR,
			avgRtt: null,
			jitter: null,
			lossRate: Number(lossRate.toFixed(2)),
		};
	}

	const avgRtt = okLatencies.reduce((a, b) => a + b, 0) / okLatencies.length;
	const jitter = okLatencies.reduce((a, b) => a + Math.abs(b - avgRtt), 0) /
		okLatencies.length;

	let quality: Quality;
	if (lossRate > thresholds.veryPoor.lossRate || avgRtt > thresholds.veryPoor.avgRtt) {
		quality = QUALITY.VERY_POOR;
	} else if (avgRtt > thresholds.poor.avgRtt || jitter > thresholds.poor.jitter) {
		quality = QUALITY.POOR;
	} else if (avgRtt > thresholds.fair.avgRtt) {
		quality = QUALITY.FAIR;
	} else if (
		avgRtt > thresholds.good.avgRtt ||
		jitter > thresholds.good.jitter ||
		lossRate > 0
	) {
		quality = QUALITY.GOOD;
	} else {
		quality = QUALITY.EXCELLENT;
	}

	return {
		quality,
		avgRtt: Math.round(avgRtt),
		jitter: Math.round(jitter),
		lossRate: Number(lossRate.toFixed(2)),
	};
}

/**
 * Hysteresis filter: dampens flapping by requiring `requiredConsecutive`
 * observations of a worse-than-current bucket before the downgrade is reported.
 * Upgrades (toward better quality) and offline-state transitions are applied
 * immediately — only downgrades are gated.
 *
 * The `state` argument is opaque and is owned by the monitor; pass it through
 * unchanged on each call.
 */
export interface HysteresisState {
	/** Number of consecutive samples observed at the pending (worse) level. */
	pendingCount: number;
	/** The pending worse level — set when a downgrade was seen but not yet applied. */
	pendingLevel: Quality | null;
}

/**
 * Constructs the opaque counter object consumed by {@link applyHysteresis}.
 * The monitor owns one per instance and passes it through unchanged on each
 * call.
 */
export function createHysteresisState(): HysteresisState {
	return { pendingCount: 0, pendingLevel: null };
}

/**
 * Applies hysteresis to a fresh verdict given the previously *reported*
 * quality and the running counter state.
 */
export function applyHysteresis(
	reported: Quality,
	fresh: Quality,
	requiredConsecutive: number,
	state: HysteresisState,
): Quality {
	if (requiredConsecutive <= 0 || fresh >= reported) {
		// Upgrade (or equal): apply immediately and clear pending state.
		state.pendingCount = 0;
		state.pendingLevel = null;
		return fresh;
	}

	// Downgrade path — gate behind N consecutive observations.
	if (state.pendingLevel !== fresh) {
		state.pendingLevel = fresh;
		state.pendingCount = 1;
	} else {
		state.pendingCount += 1;
	}

	if (state.pendingCount >= requiredConsecutive) {
		state.pendingCount = 0;
		state.pendingLevel = null;
		return fresh;
	}
	return reported;
}
