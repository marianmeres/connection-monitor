import { assert, assertEquals } from "@std/assert";

import { createConnectionMonitor } from "../src/create-connection-monitor.ts";
import { type ConnectionStatus, type Fetcher, QUALITY } from "../src/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeFetcher(delayMs: number): Fetcher {
	return (_input, init) =>
		new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, delayMs);
			init.signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new Error("aborted"));
			});
		});
}

Deno.test("start() is idempotent — repeat calls are no-ops", () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
		interval: 60_000,
	});
	monitor.start();
	monitor.start();
	monitor.start();
	assertEquals(monitor.isRunning(), true);
	monitor.stop();
});

Deno.test("stop() is idempotent — repeat calls are no-ops", () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
	});
	monitor.start();
	monitor.stop();
	monitor.stop();
	monitor.stop();
	assertEquals(monitor.isRunning(), false);
});

Deno.test("subscribers see running flips on start/stop", () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
		interval: 60_000,
	});
	const seen: boolean[] = [];
	monitor.subscribe((s) => seen.push(s.running));

	monitor.start();
	monitor.stop();

	// initial (false), start (true), [optional probe updates], stop (false)
	assertEquals(seen[0], false);
	assertEquals(seen[seen.length - 1], false);
	assert(seen.includes(true), "subscribers should observe running=true");
});

Deno.test("restart after stop replays the lifecycle", async () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
		interval: 60_000,
	});
	monitor.start();
	await monitor.probe();
	monitor.stop();

	monitor.start();
	await monitor.probe();
	const snap = monitor.get();
	assertEquals(snap.running, true);
	assert(snap.samples >= 1);
	monitor.stop();
});

Deno.test("stop() clears probe loop — no further samples land", async () => {
	let calls = 0;
	const fetcher: Fetcher = (_input, init) => {
		calls++;
		return new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, 5);
			init.signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new Error("aborted"));
			});
		});
	};
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 30, // short interval so the loop would tick if not stopped
	});
	monitor.start();
	await sleep(80); // 2-3 ticks should have happened by now
	const callsDuringRun = calls;
	monitor.stop();
	await sleep(60);
	assertEquals(calls, callsDuringRun, "no probe calls after stop()");
});

Deno.test("hysteresis: GOOD->POOR downgrade delayed until N consecutive samples", async () => {
	let response = 5; // fast
	const fetcher: Fetcher = (_input, init) =>
		new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, response);
			init.signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new Error("aborted"));
			});
		});
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
		windowSize: 1, // each new sample fully replaces the window
		hysteresis: 2,
	});
	monitor.start();
	await monitor.probe();
	const okQuality = monitor.get().quality;
	assert(okQuality >= QUALITY.GOOD, "fast probe should yield GOOD or EXCELLENT");

	// First slow sample: would normally downgrade, but hysteresis holds it.
	response = 700;
	await monitor.probe();
	assertEquals(monitor.get().quality, okQuality, "first slow sample held");

	// Second slow sample: downgrade applies.
	await monitor.probe();
	assertEquals(monitor.get().quality, QUALITY.POOR);
	monitor.stop();
});

Deno.test("status.samples grows up to windowSize then plateaus", async () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
		interval: 60_000,
		windowSize: 3,
	});
	monitor.start();
	await monitor.probe();
	await monitor.probe();
	await monitor.probe();
	await monitor.probe();
	await monitor.probe();
	assertEquals(monitor.get().samples, 3);
	monitor.stop();
});

Deno.test("Symbol.dispose works on the unsubscriber", () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(5),
	});
	let count = 0;
	const unsub = monitor.subscribe(() => count++);
	const before = count;
	(unsub as unknown as Disposable)[Symbol.dispose]();
	monitor.start();
	monitor.stop();
	assertEquals(count, before, "disposed subscriber should not fire");
});

Deno.test("subscribers receive the full status object including avgRtt/jitter", async () => {
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher: makeFetcher(50),
		interval: 60_000,
	});
	const received: ConnectionStatus[] = [];
	monitor.subscribe((s) => received.push(s));
	monitor.start();
	await monitor.probe();
	monitor.stop();

	const withSample = received.find((s) => s.samples > 0);
	assert(withSample !== undefined, "expected at least one status with samples > 0");
	assert(typeof withSample!.avgRtt === "number");
	assert(typeof withSample!.jitter === "number");
	assertEquals(withSample!.lossRate, 0);
});
