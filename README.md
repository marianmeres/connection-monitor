# @marianmeres/connection-monitor

[![NPM version](https://img.shields.io/npm/v/@marianmeres/connection-monitor)](https://www.npmjs.com/package/@marianmeres/connection-monitor)
[![JSR version](https://jsr.io/badges/@marianmeres/connection-monitor)](https://jsr.io/@marianmeres/connection-monitor)

Reactive, framework-agnostic browser connection-quality monitor with a
[store-compatible](https://github.com/marianmeres/store) `subscribe` API.

Reports a numeric quality verdict (0..5) plus the latency / jitter / loss
metrics behind it. Quality is measured live — the package actively probes a
same-origin endpoint on a configurable cadence and (optionally) augments the
window with passive `PerformanceObserver` samples from real traffic. No
third-party telemetry, no analytics, no remote config.

## Install

```shell
npm i @marianmeres/connection-monitor
```

```shell
deno add jsr:@marianmeres/connection-monitor
```

## Basic Usage

```typescript
import { createConnectionMonitor, QUALITY } from "@marianmeres/connection-monitor";

const monitor = createConnectionMonitor({
	url: "/ping", // same-origin endpoint that returns 204
	interval: 5000, // probe every 5s
	timeout: 3000, // a probe slower than this counts as failed
});

const unsub = monitor.subscribe((status) => {
	if (status.quality === QUALITY.OFFLINE) {
		showOfflineBanner();
	} else if (status.quality <= QUALITY.POOR) {
		showWeakConnectionWarning();
	} else {
		hideIndicators();
	}
});

// Later: stop and clean up
monitor.stop();
unsub();
```

Each probe appends a cache-busting query param and is sent with
`cache: "no-store"`, so the endpoint does not need to set `Cache-Control`
headers itself.

`subscribe(cb)` is the Svelte-store contract — the callback is invoked
**immediately** with the current status and again on every change, including
`running` flipping on `start()` / `stop()`. So in Svelte you can write:

```svelte
<script>
    import { createConnectionMonitor } from "@marianmeres/connection-monitor";
    const monitor = createConnectionMonitor({ url: "/ping" });
</script>

{#if !$monitor.running}
    <button onclick={() => monitor.start()}>start monitor</button>
{:else if $monitor.quality === 0}
    <OfflineBanner />
{:else}
    <SignalBars value={$monitor.quality} />
{/if}
```

## Quality scale

`status.quality` is a numeric scale, ordered from worst (`0`) to best (`5`),
with named constants exported for readability:

| Constant            | Value | Default trigger (worst-first)              |
| ------------------- | ----- | ------------------------------------------ |
| `QUALITY.OFFLINE`   | 0     | `navigator.onLine === false` or all-fail   |
| `QUALITY.VERY_POOR` | 1     | `avgRtt > 1500` or `lossRate > 0.4`        |
| `QUALITY.POOR`      | 2     | `avgRtt > 600` or `jitter > 300`           |
| `QUALITY.FAIR`      | 3     | `avgRtt > 250`                             |
| `QUALITY.GOOD`      | 4     | `avgRtt > 100`, `jitter > 60`, or any loss |
| `QUALITY.EXCELLENT` | 5     | `avgRtt ≤ 100`, `jitter ≤ 60`, no loss     |

Numeric values are ordered, so comparisons work naturally:

```typescript
if (status.quality <= QUALITY.POOR) { /* needs attention */ }
if (status.quality >= QUALITY.GOOD) { /* hide spinners */ }
```

All thresholds are overridable via the `thresholds` option — see
[API.md](./API.md).

## Passive observation (opt-in)

Set `passive: true` to additionally observe `PerformanceObserver` `resource`
entries. Successful, non-cached, same-origin (or `Timing-Allow-Origin`-enabled)
responses contribute their TTFB to the rolling window — so the verdict reacts
faster between probes when your app is making real requests, and the next
scheduled probe is skipped when a fresh passive sample already says the
network is healthy.

```typescript
const monitor = createConnectionMonitor({
	url: "/ping",
	passive: true,
});
```

Passive mode is browser-only. In SSR / Node / Deno it silently no-ops.

## Hysteresis

By default the verdict reflects each rolling-window evaluation immediately.
For UI status indicators where flicker is undesirable, require N consecutive
downgrade observations before lowering the reported quality:

```typescript
const monitor = createConnectionMonitor({
	url: "/ping",
	hysteresis: 2, // need 2 consecutive worse samples before downgrading
});
```

Upgrades (toward better quality) and the `OFFLINE` transition are always
applied immediately. Only sustained downgrades are gated.

## Injectable logger

The monitor accepts any logger satisfying the
[`@marianmeres/clog`](https://jsr.io/@marianmeres/clog) `Logger` interface
(`debug` / `log` / `warn` / `error`). Only **lifecycle events** (start, stop)
and **quality transitions** are logged — individual probe failures are signal,
not errors, and are never logged.

```typescript
import { createClog } from "@marianmeres/clog";

const monitor = createConnectionMonitor({
	url: "/ping",
	logger: createClog("net"),
});
```

If no logger is provided, the monitor uses a no-op logger and produces no
output.

## Behavior Notes

- **The factory auto-starts by default.** Set `autoStart: false` to wire
  subscribers before probing begins.
- **The first probe fires immediately** after `start()` (modulo a single event
  loop turn), so subscribers leave the initial `OFFLINE` state quickly — no
  need to wait one full `interval`.
- **`subscribe(cb)` calls `cb` synchronously** with the current status, then
  asynchronously on each change.
- **`stop()` is reversible.** It detaches listeners and clears the probe loop,
  but `start()` can be called again to resume.
- **Going offline (`navigator.onLine === false`) clears the sample window** —
  stale samples don't survive a connectivity loss. The verdict snaps to
  `OFFLINE` immediately.
- **SSR-safe.** All browser APIs are guarded; importing the package in
  Node/Deno does not throw, and `isBrowser()` returns false there.

## API Reference

See [API.md](./API.md) for the full reference.

### Exports

| Name                        | Kind     | Description                                      |
| --------------------------- | -------- | ------------------------------------------------ |
| `createConnectionMonitor`   | factory  | Main entry point.                                |
| `QUALITY` / `QUALITY_LABEL` | const    | Named constants for the 0..5 quality scale.      |
| `evaluateQuality`           | function | Pure verdict-from-samples helper (testable).     |
| `resolveThresholds`         | function | Merge partial overrides with the defaults.       |
| `DEFAULT_THRESHOLDS`        | const    | The default threshold map.                       |
| `createPassiveObserver`     | function | Standalone wrapper around `PerformanceObserver`. |
| `isBrowser`                 | function | SSR guard.                                       |

### Monitor methods

`subscribe()`, `get()`, `isRunning()`, `start()`, `stop()`, `probe()`.

## License

[MIT](LICENSE)
