/**
 * Detects if the code is running in a browser environment.
 *
 * Checks for the presence of `window`, `document`, and that `globalThis ===
 * window`. This distinguishes real browsers from Node/Deno runtimes that may
 * expose partial DOM globals.
 */
export function isBrowser(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof document !== "undefined" &&
		globalThis === (window as unknown as typeof globalThis)
	);
}

/**
 * Returns `true` if `PerformanceObserver` is available — required for passive
 * observation. Independent from `isBrowser()` since some test environments
 * polyfill one but not the other.
 */
export function hasPerformanceObserver(): boolean {
	return typeof PerformanceObserver !== "undefined";
}
