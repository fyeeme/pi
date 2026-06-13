import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageResult } from "./types.ts";
import type { TokenUsage } from "./types.ts";
import type { UsageProvider } from "./providers/types.ts";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function fmt(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

export function formatDuration(sec: number): string {
	if (sec < 60) return `${Math.floor(sec)}s`;
	const min = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${min}m${s}s`;
}

/** Format countdown from epoch ms to XhYm string. */
export function formatCountdown(resetAt: number): string {
	if (!resetAt) return "?";
	const remainingMs = resetAt - Date.now();
	if (remainingMs <= 0) return "0m";
	const totalMin = Math.floor(remainingMs / 60000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

export function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

export { truncateToWidth, visibleWidth };

// ---------------------------------------------------------------------------
// Footer line builders
// ---------------------------------------------------------------------------

export function buildStatLine(
	stats: TokenUsage & { cost: number; currency: "¥" | "$" },
	contextUsage: ContextUsage | undefined,
	providerResult: ProviderUsageResult,
	providers: Record<string, UsageProvider>,
	getElapsedSec: () => number,
	lastTps: number,
	mcpStatuses: Map<string, { connected: boolean; toolCount: number }>,
): string {
	const mods: string[] = [];

	// token flow: in 29k, out 22k, cache 515k, total 566k
	{
		const tok: string[] = [];
		if (stats.input) tok.push(`in ${fmt(stats.input)}`);
		if (stats.output) tok.push(`out ${fmt(stats.output)}`);
		const cache = stats.cacheRead + stats.cacheWrite;
		if (cache) tok.push(`cache ${fmt(cache)}`);
		if (stats.total) tok.push(`total ${fmt(stats.total)}`);
		if (tok.length) mods.push(tok.join(", "));
	}

	// Provider-specific cost/usage
	if (providerResult) {
		const providerName = providerResult.provider;
		const provider = providers[providerName];
		if (provider) {
			const formatted = provider.formatForFooter(providerResult, stats.cost, stats.currency);
			if (formatted) mods.push(formatted);
		}
	} else {
		if (stats.cost > 0) {
			mods.push(`${stats.currency}${stats.cost.toFixed(2)}`);
		}
	}

	// context: 45.2%/16k or ?/16k
	if (contextUsage) {
		const w = fmt(contextUsage.contextWindow);
		mods.push(
			contextUsage.percent !== null
				? `${contextUsage.percent.toFixed(1)}%/${w}`
				: `?/${w}`,
		);
	}

	// timing: 2m30s 39.5 tok/s
	{
		const t: string[] = [];
		const elapsed = getElapsedSec();
		if (elapsed > 0) t.push(formatDuration(elapsed));
		if (lastTps > 0) t.push(`${lastTps.toFixed(1)} tok/s`);
		if (t.length) mods.push(t.join(" "));
	}

	// MCP: MCP:2(15) or MCP:0
	{
		const entries = Array.from(mcpStatuses.entries());
		if (entries.length) {
			const connected = entries.filter(([, s]) => s.connected).length;
			const tools = entries.reduce((sum, [, s]) => sum + s.toolCount, 0);
			mods.push(connected > 0 ? `MCP:${connected}(${tools})` : "MCP:0");
		}
	}

	return mods.join(" · ");
}

export function buildInfoLine(modelId: string | undefined, thinkingLevel: string): string {
	const parts: string[] = [];
	if (modelId) parts.push(modelId);
	if (thinkingLevel && thinkingLevel !== "off") parts.push(thinkingLevel);
	return parts.join(" · ");
}
