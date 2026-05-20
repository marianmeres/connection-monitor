import { assertEquals, assertStrictEquals } from "@std/assert";

import {
	applyHysteresis,
	createHysteresisState,
	DEFAULT_THRESHOLDS,
	evaluateQuality,
	resolveThresholds,
} from "../src/evaluate-quality.ts";
import { QUALITY, type Sample } from "../src/types.ts";

function sample(
	latency: number,
	source: "active" | "passive" = "active",
	ok = true,
): Sample {
	return { ok, latency, source, timestamp: 0 };
}

Deno.test("evaluateQuality: empty window -> OFFLINE with null metrics", () => {
	const v = evaluateQuality([]);
	assertEquals(v.quality, QUALITY.OFFLINE);
	assertEquals(v.avgRtt, null);
	assertEquals(v.jitter, null);
	assertEquals(v.lossRate, 0);
});

Deno.test("evaluateQuality: all-failed active window -> VERY_POOR", () => {
	const v = evaluateQuality([
		sample(3000, "active", false),
		sample(3000, "active", false),
	]);
	assertEquals(v.quality, QUALITY.VERY_POOR);
	assertEquals(v.avgRtt, null);
	assertEquals(v.jitter, null);
	assertEquals(v.lossRate, 1);
});

Deno.test("evaluateQuality: ideal samples -> EXCELLENT", () => {
	const v = evaluateQuality([
		sample(50),
		sample(60),
		sample(55),
		sample(58),
	]);
	assertEquals(v.quality, QUALITY.EXCELLENT);
	assertEquals(v.lossRate, 0);
});

Deno.test("evaluateQuality: any loss demotes EXCELLENT -> GOOD", () => {
	const v = evaluateQuality([
		sample(50),
		sample(60),
		sample(55),
		sample(3000, "active", false),
	]);
	// 1 failure / 4 active = 0.25, below veryPoor.lossRate threshold of 0.4,
	// so it does not jump to VERY_POOR. avg of ok samples is ~55ms.
	assertEquals(v.quality, QUALITY.GOOD);
});

Deno.test("evaluateQuality: avgRtt > good.avgRtt -> GOOD", () => {
	const v = evaluateQuality([sample(120), sample(140), sample(130)]);
	assertEquals(v.quality, QUALITY.GOOD);
	assertEquals(v.avgRtt, 130);
});

Deno.test("evaluateQuality: avgRtt > fair.avgRtt -> FAIR", () => {
	const v = evaluateQuality([sample(280), sample(300), sample(290)]);
	assertEquals(v.quality, QUALITY.FAIR);
});

Deno.test("evaluateQuality: avgRtt > poor.avgRtt -> POOR", () => {
	const v = evaluateQuality([sample(700), sample(800), sample(750)]);
	assertEquals(v.quality, QUALITY.POOR);
});

Deno.test("evaluateQuality: high jitter alone triggers POOR", () => {
	const v = evaluateQuality([sample(100), sample(500), sample(100), sample(500)]);
	// avg = 300, jitter = 200 — avg falls in FAIR bucket, but plain FAIR has no
	// jitter clause. POOR's jitter cap is 300, so 200 stays in FAIR.
	assertEquals(v.quality, QUALITY.FAIR);

	const v2 = evaluateQuality([sample(100), sample(900), sample(100), sample(900)]);
	// avg = 500, jitter = 400 — jitter > poor.jitter (300) triggers POOR.
	assertEquals(v2.quality, QUALITY.POOR);
});

Deno.test("evaluateQuality: avgRtt > veryPoor.avgRtt -> VERY_POOR", () => {
	const v = evaluateQuality([sample(1600), sample(1700)]);
	assertEquals(v.quality, QUALITY.VERY_POOR);
});

Deno.test("evaluateQuality: high lossRate -> VERY_POOR", () => {
	// 3 failures, 1 success → loss = 0.75, exceeds 0.4
	const v = evaluateQuality([
		sample(50),
		sample(3000, "active", false),
		sample(3000, "active", false),
		sample(3000, "active", false),
	]);
	assertEquals(v.quality, QUALITY.VERY_POOR);
});

Deno.test("evaluateQuality: passive samples contribute to avg but not lossRate", () => {
	const v = evaluateQuality([
		sample(50, "passive"),
		sample(60, "passive"),
		sample(3000, "active", false),
	]);
	// activeAttempts = [failed] -> lossRate = 1
	// ok samples = [50, 60] -> avg = 55
	assertEquals(v.avgRtt, 55);
	assertEquals(v.lossRate, 1);
	assertEquals(v.quality, QUALITY.VERY_POOR);
});

Deno.test("evaluateQuality: only passive samples -> lossRate stays 0", () => {
	const v = evaluateQuality([sample(80, "passive"), sample(70, "passive")]);
	assertEquals(v.lossRate, 0);
	assertEquals(v.avgRtt, 75);
});

Deno.test("evaluateQuality: thresholds can be overridden partially", () => {
	const aggressive = resolveThresholds({ fair: { avgRtt: 100 } });
	const v = evaluateQuality([sample(150), sample(160)], aggressive);
	// avg=155 > fair.avgRtt=100 → FAIR (would have been GOOD with defaults)
	assertEquals(v.quality, QUALITY.FAIR);
});

Deno.test("resolveThresholds: returns defaults when no overrides", () => {
	const t = resolveThresholds();
	assertEquals(t, DEFAULT_THRESHOLDS);
});

Deno.test("resolveThresholds: merges partial overrides", () => {
	const t = resolveThresholds({ poor: { avgRtt: 999 } });
	assertEquals(t.poor.avgRtt, 999);
	assertEquals(t.poor.jitter, DEFAULT_THRESHOLDS.poor.jitter);
	assertEquals(t.veryPoor, DEFAULT_THRESHOLDS.veryPoor);
});

Deno.test("applyHysteresis: zero hysteresis applies downgrade immediately", () => {
	const state = createHysteresisState();
	const out = applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 0, state);
	assertEquals(out, QUALITY.POOR);
});

Deno.test("applyHysteresis: upgrades apply immediately regardless of N", () => {
	const state = createHysteresisState();
	const out = applyHysteresis(QUALITY.POOR, QUALITY.EXCELLENT, 5, state);
	assertEquals(out, QUALITY.EXCELLENT);
});

Deno.test("applyHysteresis: downgrade is delayed by N consecutive observations", () => {
	const state = createHysteresisState();
	// hysteresis = 3 → need 3 consecutive worse samples
	assertEquals(applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 3, state), QUALITY.GOOD);
	assertEquals(applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 3, state), QUALITY.GOOD);
	assertEquals(applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 3, state), QUALITY.POOR);
});

Deno.test("applyHysteresis: counter resets on a different worse level", () => {
	const state = createHysteresisState();
	assertEquals(applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 3, state), QUALITY.GOOD);
	assertEquals(
		applyHysteresis(QUALITY.GOOD, QUALITY.VERY_POOR, 3, state),
		QUALITY.GOOD,
	);
	// pendingLevel switched — count restarts at 1
	assertStrictEquals(state.pendingLevel, QUALITY.VERY_POOR);
	assertStrictEquals(state.pendingCount, 1);
});

Deno.test("applyHysteresis: counter resets after upgrade", () => {
	const state = createHysteresisState();
	applyHysteresis(QUALITY.GOOD, QUALITY.POOR, 3, state);
	applyHysteresis(QUALITY.GOOD, QUALITY.GOOD, 3, state);
	assertStrictEquals(state.pendingLevel, null);
	assertStrictEquals(state.pendingCount, 0);
});
