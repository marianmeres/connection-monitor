import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { createConnectionMonitor } from "../src/create-connection-monitor.ts";
import { type ConnectionStatus, type Fetcher, QUALITY } from "../src/types.ts";

/** Tiny sleep helper. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Returns a deterministic fetcher that resolves after `delayMs`, plus a
 * counter of how many times it was invoked.
 */
function makeFetcher(
	delayMs: number,
): Fetcher & { calls: () => number } {
	let calls = 0;
	const fn: Fetcher = (_input, init) =>
		new Promise<void>((resolve, reject) => {
			calls++;
			const t = setTimeout(resolve, delayMs);
			init.signal.addEventListener("abort", () => {
				clearTimeout(t);
				reject(new Error("aborted"));
			});
		});
	(fn as Fetcher & { calls: () => number }).calls = () => calls;
	return fn as Fetcher & { calls: () => number };
}

Deno.test("subscribe is called immediately with current status (Svelte contract)", () => {
	const monitor = createConnectionMonitor({ autoStart: false });
	const received: ConnectionStatus[] = [];
	const unsub = monitor.subscribe((s) => received.push(s));
	assertEquals(received.length, 1);
	assertEquals(received[0].running, false);
	assertEquals(received[0].quality, QUALITY.OFFLINE);
	assertEquals(received[0].samples, 0);
	unsub();
	monitor.stop();
});

Deno.test("get() returns the current status snapshot", () => {
	const monitor = createConnectionMonitor({ autoStart: false });
	const snap = monitor.get();
	assertEquals(snap.running, false);
	assertEquals(snap.quality, QUALITY.OFFLINE);
	monitor.stop();
});

Deno.test("start() flips running and notifies subscribers", () => {
	const monitor = createConnectionMonitor({ autoStart: false });
	const received: boolean[] = [];
	monitor.subscribe((s) => received.push(s.running));
	monitor.start();
	monitor.stop();
	// expect: false (initial) -> true (start) -> at least one running=true probe
	// recompute -> false (stop)
	assertEquals(received[0], false);
	assert(received.includes(true), "subscribers should see running=true");
	assertEquals(received[received.length - 1], false);
});

Deno.test("probe() records a sample and updates status", async () => {
	const fetcher = makeFetcher(10);
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000, // effectively disable the auto-loop for this test
	});
	monitor.start();
	await monitor.probe();
	const snap = monitor.get();
	assert(snap.samples >= 1, "expected at least one sample");
	assertNotEquals(snap.quality, QUALITY.OFFLINE);
	assertEquals(snap.source, "active");
	monitor.stop();
});

Deno.test("multiple subscribers all receive updates", async () => {
	const fetcher = makeFetcher(5);
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
	});
	const counts = [0, 0];
	monitor.subscribe(() => counts[0]++);
	monitor.subscribe(() => counts[1]++);
	monitor.start();
	await monitor.probe();
	assertEquals(counts[0], counts[1]);
	assert(counts[0] >= 2, "expected at least initial + post-probe updates");
	monitor.stop();
});

Deno.test("unsubscribing stops further updates", async () => {
	const fetcher = makeFetcher(5);
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
	});
	let count = 0;
	const unsub = monitor.subscribe(() => count++);
	unsub();
	const before = count;
	monitor.start();
	await monitor.probe();
	monitor.stop();
	assertEquals(count, before, "no further updates after unsubscribe");
});

Deno.test("logger receives lifecycle events but not per-probe spam", async () => {
	const fetcher = makeFetcher(5);
	const lines: string[] = [];
	const logger = {
		debug: () => "",
		log: (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
			return "";
		},
		warn: () => "",
		error: () => "",
	};
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
		logger,
	});
	monitor.start();
	await monitor.probe();
	await monitor.probe();
	await monitor.probe();
	monitor.stop();

	const startLines = lines.filter((l) => l.includes("monitor started"));
	const stopLines = lines.filter((l) => l.includes("monitor stopped"));
	assertEquals(startLines.length, 1, "expected exactly one start log");
	assertEquals(stopLines.length, 1, "expected exactly one stop log");

	// Should never log a per-probe failure (those are signal, not errors).
	const probeFailureLines = lines.filter((l) => l.includes("probe failure"));
	assertEquals(probeFailureLines.length, 0);
});

Deno.test("threshold override changes the verdict", async () => {
	const fetcher = makeFetcher(5);
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
		// force every successful probe into POOR
		thresholds: { poor: { avgRtt: 1 } },
	});
	monitor.start();
	await monitor.probe();
	assertEquals(monitor.get().quality, QUALITY.POOR);
	monitor.stop();
});

Deno.test("subscriber error is routed to logger.error, other subs continue", async () => {
	const fetcher = makeFetcher(5);
	const errors: string[] = [];
	const logger = {
		debug: () => "",
		log: () => "",
		warn: () => "",
		error: (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
			return "";
		},
	};
	const monitor = createConnectionMonitor({
		autoStart: false,
		fetcher,
		interval: 60_000,
		logger,
	});

	let goodReceived = 0;
	monitor.subscribe(() => {
		throw new Error("subscriber boom");
	});
	monitor.subscribe(() => goodReceived++);

	monitor.start();
	await monitor.probe();
	monitor.stop();

	assert(errors.length > 0, "expected at least one error log");
	assert(
		errors.some((e) => e.includes("subscriber boom")),
		"logger.error should carry the original message",
	);
	assert(goodReceived > 0, "well-behaved subscriber should still receive updates");
});

Deno.test("probe() is a no-op when not running", async () => {
	const fetcher = makeFetcher(5);
	const monitor = createConnectionMonitor({ autoStart: false, fetcher });
	await monitor.probe();
	assertEquals(monitor.get().samples, 0);
	assertEquals(fetcher.calls(), 0);
	monitor.stop();
});

Deno.test("autoStart=true starts immediately", async () => {
	const fetcher = makeFetcher(5);
	const monitor = createConnectionMonitor({
		autoStart: true,
		fetcher,
		interval: 60_000,
	});
	assertEquals(monitor.isRunning(), true);
	// drain the immediate (setTimeout 0) probe so it doesn't leak past the test
	await sleep(30);
	monitor.stop();
});
