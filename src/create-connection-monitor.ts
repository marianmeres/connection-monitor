import { createNoopClog, type Logger } from "@marianmeres/clog";
import { createPubSub, type Unsubscriber } from "@marianmeres/pubsub";

import {
	applyHysteresis,
	createHysteresisState,
	evaluateQuality,
	resolveThresholds,
} from "./evaluate-quality.ts";
import {
	createPassiveObserver,
	type PassiveObserver,
} from "./create-passive-observer.ts";
import { isBrowser } from "./is-browser.ts";
import {
	type ConnectionMonitor,
	type ConnectionMonitorOptions,
	type ConnectionStatus,
	type Fetcher,
	QUALITY,
	QUALITY_LABEL,
	type Sample,
	type Source,
} from "./types.ts";

const LOGGER_NS = "connection-monitor";

function nowMs(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

const defaultFetcher: Fetcher = (input, init) =>
	fetch(input, {
		method: init.method,
		cache: init.cache,
		signal: init.signal,
	});

/**
 * Creates a reactive connection-quality monitor. See the package README for an
 * end-to-end overview and the {@link ConnectionMonitorOptions} doc for option
 * details.
 *
 * The returned monitor exposes a Svelte-store-compatible `subscribe` API: the
 * callback is invoked immediately with the current status and again on every
 * change. The status object carries both the quality verdict and the
 * lifecycle `running` flag, so a single subscription can drive a complete UI.
 *
 * @example
 * ```ts
 * const monitor = createConnectionMonitor({ url: "/ping" });
 * const unsub = monitor.subscribe((s) => render(s));
 * // ... later
 * unsub();
 * monitor.stop();
 * ```
 */
export function createConnectionMonitor(
	options: ConnectionMonitorOptions = {},
): ConnectionMonitor {
	const url = options.url ?? "/ping";
	const interval = options.interval ?? 5000;
	const timeout = options.timeout ?? 3000;
	const windowSize = options.windowSize ?? 5;
	const pauseWhenHidden = options.pauseWhenHidden ?? true;
	const autoStart = options.autoStart ?? true;
	const passive = options.passive ?? false;
	const hysteresis = options.hysteresis ?? 0;
	const thresholds = resolveThresholds(options.thresholds);
	const fetcher = options.fetcher ?? defaultFetcher;
	const logger: Logger = options.logger ?? createNoopClog(LOGGER_NS);

	const pubsub = createPubSub<{ change: ConnectionStatus }>({
		onError: (err) =>
			logger.error(`subscriber error: ${err?.message ?? String(err)}`),
	});

	const samples: Sample[] = [];
	const hysteresisState = createHysteresisState();

	let status: ConnectionStatus = {
		running: false,
		quality: QUALITY.OFFLINE,
		avgRtt: null,
		jitter: null,
		lossRate: 0,
		samples: 0,
		lastSampleAt: null,
		source: "offline",
	};

	let probeLoopActive = false;
	let timerId: ReturnType<typeof setTimeout> | null = null;
	let passiveObserver: PassiveObserver | null = null;
	let visibilityHandler: (() => void) | null = null;
	let onlineHandler: (() => void) | null = null;
	let offlineHandler: (() => void) | null = null;
	let pausedByVisibility = false;
	let lastPassiveAt: number | null = null;
	let inFlightProbe: Promise<void> | null = null;
	const inFlightControllers = new Set<AbortController>();

	function isOffline(): boolean {
		return (
			typeof navigator !== "undefined" &&
			"onLine" in navigator &&
			navigator.onLine === false
		);
	}

	function publishStatus(next: ConnectionStatus): void {
		const prev = status;
		status = next;

		if (prev.quality !== next.quality) {
			if (next.quality === QUALITY.OFFLINE) {
				logger.log("connection offline");
			} else if (prev.quality === QUALITY.OFFLINE) {
				logger.log(
					`connection restored — quality: ${next.quality} (${
						QUALITY_LABEL[next.quality]
					})`,
				);
			} else {
				logger.log(
					`quality: ${prev.quality} (${
						QUALITY_LABEL[prev.quality]
					}) -> ${next.quality} (${QUALITY_LABEL[next.quality]}) — avgRtt=${
						next.avgRtt ?? "n/a"
					}ms`,
				);
			}
		}

		pubsub.publish("change", next);
	}

	function recompute(source: Source): void {
		const verdict = evaluateQuality(samples, thresholds);
		const quality = applyHysteresis(
			status.quality,
			verdict.quality,
			hysteresis,
			hysteresisState,
		);
		publishStatus({
			running: status.running,
			quality,
			avgRtt: verdict.avgRtt,
			jitter: verdict.jitter,
			lossRate: verdict.lossRate,
			samples: samples.length,
			lastSampleAt: samples.length > 0
				? samples[samples.length - 1].timestamp
				: null,
			source,
		});
	}

	function recordSample(sample: Sample): void {
		// After stop(), in-flight probes may still resolve/reject — ignore them
		// so they don't pollute the window or republish stale state.
		if (!status.running) return;
		samples.push(sample);
		if (samples.length > windowSize) samples.shift();
		recompute(sample.source);
	}

	function publishOffline(): void {
		// Reset the window — stale samples don't survive a connectivity loss.
		samples.length = 0;
		lastPassiveAt = null;
		publishStatus({
			running: status.running,
			quality: QUALITY.OFFLINE,
			avgRtt: null,
			jitter: null,
			lossRate: 1,
			samples: 0,
			lastSampleAt: null,
			source: "offline",
		});
	}

	function shouldSkipProbe(): boolean {
		// Adaptive cadence: if a passive sample arrived recently and looked
		// healthy, we don't need to spend a probe this tick.
		if (lastPassiveAt === null) return false;
		const last = samples[samples.length - 1];
		if (!last || last.source !== "passive") return false;
		const elapsed = nowMs() - lastPassiveAt;
		return elapsed < interval / 2 && last.latency <= thresholds.fair.avgRtt;
	}

	async function doProbe(): Promise<void> {
		// Serialize: concurrent callers await the in-flight probe rather than
		// kicking off parallel fetches. Prevents timer leaks and double-counted
		// samples when the loop tick and a manual `.probe()` race.
		if (inFlightProbe) return inFlightProbe;

		if (isOffline()) {
			publishOffline();
			return;
		}
		if (shouldSkipProbe()) return;

		const controller = new AbortController();
		inFlightControllers.add(controller);
		const timeoutTimer = setTimeout(() => controller.abort(), timeout);
		const start = nowMs();
		const busted = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;

		inFlightProbe = (async () => {
			try {
				await fetcher(busted, {
					method: "GET",
					cache: "no-store",
					signal: controller.signal,
				});
				recordSample({
					ok: true,
					latency: nowMs() - start,
					source: "active",
					timestamp: nowMs(),
				});
			} catch {
				recordSample({
					ok: false,
					latency: timeout,
					source: "active",
					timestamp: nowMs(),
				});
			} finally {
				clearTimeout(timeoutTimer);
				inFlightControllers.delete(controller);
			}
		})();

		try {
			await inFlightProbe;
		} finally {
			inFlightProbe = null;
		}
	}

	function startProbeLoop(): void {
		if (probeLoopActive) return;
		probeLoopActive = true;

		const tick = async () => {
			if (!probeLoopActive) return;
			await doProbe();
			if (!probeLoopActive) return;
			timerId = setTimeout(tick, interval);
		};
		// immediate first probe so subscribers leave the OFFLINE/empty state fast
		timerId = setTimeout(tick, 0);
	}

	function stopProbeLoop(): void {
		probeLoopActive = false;
		if (timerId !== null) {
			clearTimeout(timerId);
			timerId = null;
		}
		// Abort any in-flight probes so their fetcher promise rejects, their
		// abort timer is cleared in the doProbe `finally`, and no further
		// samples land after stop().
		for (const c of inFlightControllers) c.abort();
		inFlightControllers.clear();
	}

	function attachLifecycleListeners(): void {
		if (!isBrowser()) return;

		if (pauseWhenHidden) {
			visibilityHandler = () => {
				if (document.hidden) {
					if (probeLoopActive) {
						pausedByVisibility = true;
						stopProbeLoop();
					}
				} else if (pausedByVisibility) {
					pausedByVisibility = false;
					startProbeLoop();
				}
			};
			document.addEventListener("visibilitychange", visibilityHandler);
		}

		offlineHandler = () => publishOffline();
		onlineHandler = () => {
			// Trigger an immediate probe so we can move off OFFLINE quickly.
			void doProbe();
		};
		addEventListener("offline", offlineHandler);
		addEventListener("online", onlineHandler);
	}

	function detachLifecycleListeners(): void {
		if (!isBrowser()) return;
		if (visibilityHandler) {
			document.removeEventListener("visibilitychange", visibilityHandler);
			visibilityHandler = null;
		}
		if (offlineHandler) {
			removeEventListener("offline", offlineHandler);
			offlineHandler = null;
		}
		if (onlineHandler) {
			removeEventListener("online", onlineHandler);
			onlineHandler = null;
		}
		pausedByVisibility = false;
	}

	function attachPassive(): void {
		if (!passive || passiveObserver) return;
		passiveObserver = createPassiveObserver((sample) => {
			lastPassiveAt = sample.timestamp;
			recordSample(sample);
		});
	}

	function detachPassive(): void {
		if (passiveObserver) {
			passiveObserver.stop();
			passiveObserver = null;
		}
	}

	const monitor: ConnectionMonitor = {
		subscribe(cb: (status: ConnectionStatus) => void): Unsubscriber {
			try {
				cb(status);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error(`subscriber error: ${message}`);
			}
			return pubsub.subscribe("change", cb);
		},
		get(): ConnectionStatus {
			return status;
		},
		isRunning(): boolean {
			return status.running;
		},
		start(): ConnectionMonitor {
			if (status.running) return monitor;
			logger.log(
				`monitor started (url=${url}, interval=${interval}ms${
					passive ? ", passive=true" : ""
				})`,
			);

			attachLifecycleListeners();
			attachPassive();

			publishStatus({ ...status, running: true });
			startProbeLoop();
			return monitor;
		},
		stop(): ConnectionMonitor {
			if (!status.running) return monitor;
			stopProbeLoop();
			detachLifecycleListeners();
			detachPassive();
			publishStatus({ ...status, running: false });
			logger.log("monitor stopped");
			return monitor;
		},
		async probe(): Promise<void> {
			if (!status.running) return;
			await doProbe();
		},
	};

	if (autoStart) monitor.start();
	return monitor;
}
