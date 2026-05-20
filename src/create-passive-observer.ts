import { hasPerformanceObserver } from "./is-browser.ts";
import type { Sample } from "./types.ts";

/**
 * Callback invoked for every accepted passive sample. Samples are filtered
 * before invocation — see {@link createPassiveObserver} for the rules.
 */
export type PassiveSampleHandler = (sample: Sample) => void;

/**
 * Handle returned by {@link createPassiveObserver}.
 */
export interface PassiveObserver {
	/** Disconnect the underlying `PerformanceObserver`. Idempotent. */
	stop(): void;
}

/**
 * Wraps a `PerformanceObserver` that watches `resource` entries and emits
 * cleaned TTFB samples via `onSample`.
 *
 * Filtered out:
 *
 * - Entries with `transferSize === 0` (typically memory-cache hits — they say
 *   nothing about the network).
 * - Entries with non-positive `responseStart - requestStart` (cross-origin
 *   responses without `Timing-Allow-Origin` report zeros for these fields).
 *
 * In environments without `PerformanceObserver` (Node, SSR, older browsers),
 * the function returns a no-op handle so callers can wire it up
 * unconditionally without runtime errors.
 */
export function createPassiveObserver(
	onSample: PassiveSampleHandler,
): PassiveObserver {
	if (!hasPerformanceObserver()) {
		return { stop: () => {} };
	}

	let stopped = false;
	const observer = new PerformanceObserver((list) => {
		if (stopped) return;
		for (const raw of list.getEntries()) {
			const entry = raw as PerformanceResourceTiming;
			if (entry.transferSize === 0) continue;

			const ttfb = entry.responseStart - entry.requestStart;
			if (!Number.isFinite(ttfb) || ttfb <= 0) continue;

			onSample({
				ok: true,
				latency: ttfb,
				source: "passive",
				timestamp: typeof performance !== "undefined"
					? performance.now()
					: Date.now(),
			});
		}
	});

	observer.observe({ type: "resource", buffered: true });

	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			observer.disconnect();
		},
	};
}
