/**
 * Status Line Extension v3
 *
 * Replaces the default footer with a custom status line.
 * Uses a strategy pattern to show provider-aware usage data:
 *   - DeepSeek: balance + weekly tokens (from session files)
 *   - ZAI/GLM:  rolling quota (5h + MCP) + weekly tokens (from API)
 *   - Others:   session-scoped cost only
 *
 * Commands:
 *   /status-debug  - dump session stats to /tmp/pi-status-debug.log
 *   /currency      - toggle ¥ / $ / auto
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Check if the provider name is a ZAI/GLM variant. */
function isZaiProvider(provider: string): boolean {
	return provider === "zai" || provider === "zai-coding-cn";
}

/** Extract origin from model baseUrl with fallback. */
function getOrigin(model: ExtensionContext["model"], defaultOrigin: string): string {
	try { return new URL(model?.baseUrl ?? defaultOrigin).origin; } catch { return defaultOrigin; }
}

// ---------------------------------------------------------------------------
// Types (Task 1)
// ---------------------------------------------------------------------------

type DeepSeekResult = {
	provider: "deepseek";
	totalBalance: string;
	currency: string;
	weeklyTokens: number;
};

type ZaiResult = {
	provider: "zai";
	tokensLimitPct: number;
	tokensResetAt: number;
	level: string;
	weeklyTokens: number;
	weeklyResetAt: number;
	weeklyPct: number;
	isNaturalWeek: boolean;
};

/** Quota API response shape (shared by z.ai and bigmodel.cn). */
type QuotaLimit = {
	type: string;
	unit?: number;
	number?: number;
	percentage?: number;
	nextResetTime?: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	usageDetails?: Array<{ modelCode: string; usage: number }>;
};

type QuotaResponse = {
	data?: {
		limits?: QuotaLimit[];
		level?: string;
	};
};

/** Model-usage API response (handles both object and array formats). */
type ModelUsageData = {
	totalUsage?: { totalTokensUsage?: number };
	modelSummaryList?: Array<{ modelName: string; totalTokens: number }>;
} | Array<{ totalTokens?: number }>;

type ProviderUsageResult = DeepSeekResult | ZaiResult | null;

interface UsageProvider {
	fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult>;
	formatForFooter(result: NonNullable<ProviderUsageResult>, sessionCost: number, currency: string): string;
	formatNotifyMessage(result: NonNullable<ProviderUsageResult>): string;
	debugDump(result: NonNullable<ProviderUsageResult>, w: (s: string) => void): void;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let agentStartMs: number | null = null;
let lastCtx: ExtensionContext | null = null;
let lastModel: ExtensionContext["model"] = undefined;
let agentRunning = false;
let lastElapsedSec = 0;
let lastTps = 0;
let currencyOverride: "¥" | "$" | undefined = undefined;

const mcpStatuses = new Map<string, { connected: boolean; toolCount: number }>();

// ---------------------------------------------------------------------------
// Session file scanner (Task 3)
// ---------------------------------------------------------------------------

function scanWeeklyTokens(providerName: string): number {
	const sessionsDir = join(getAgentDir(), "sessions");
	const now = new Date();
	// Natural week: Monday 00:00 UTC
	const dayOfWeek = now.getUTCDay();
	const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	const weekStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset, 0, 0, 0, 0),
	);

	let total = 0;

	try {
		const dirs = readdirSync(sessionsDir, { withFileTypes: true });
		for (const dir of dirs) {
			if (!dir.isDirectory()) continue;
			const dirPath = join(sessionsDir, dir.name);
			let files: string[];
			try {
				files = readdirSync(dirPath);
			} catch {
				continue;
			}
			for (const fname of files) {
				if (!fname.endsWith(".jsonl")) continue;
				// Check filename date is within this week
				try {
					const fileDate = new Date(fname.slice(0, 10) + "T00:00:00Z");
					if (fileDate < weekStart) continue;
				} catch {
					continue;
				}

				try {
					const content = readFileSync(join(dirPath, fname), "utf-8");
					for (const line of content.split("\n")) {
						if (!line.trim()) continue;
						try {
							const d = JSON.parse(line);
							if (
								d.type === "message" &&
								d.message?.role === "assistant" &&
								d.message?.provider === providerName
							) {
								total += d.message.usage?.totalTokens ?? 0;
							}
						} catch {
							// skip malformed lines
						}
					}
				} catch {
					// skip unreadable files
				}
			}
		}
	} catch {
		// sessions dir doesn't exist or is unreadable
	}

	return total;
}

// ---------------------------------------------------------------------------
// DeepSeek Provider (Task 2)
// ---------------------------------------------------------------------------

class DeepSeekProvider implements UsageProvider {
	async fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult> {
		if (!model || model.provider !== "deepseek") return null;

		const apiKey = await modelRegistry.getApiKeyForProvider("deepseek");
		if (!apiKey) return null;

		const origin = getOrigin(model, "https://api.deepseek.com");

		try {
			const res = await fetch(`${origin}/user/balance`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) return null;

			const data = (await res.json()) as {
				is_available?: boolean;
				balance_infos?: Array<{
					currency?: string;
					total_balance?: string;
				}>;
			};

			const info = data.balance_infos?.[0];
			if (!info) return null;

			const weeklyTokens = scanWeeklyTokens("deepseek");

			return {
				provider: "deepseek",
				totalBalance: info.total_balance ?? "?",
				currency: info.currency ?? "CNY",
				weeklyTokens,
			};
		} catch {
			return null;
		}
	}

	formatForFooter(result: NonNullable<ProviderUsageResult>, sessionCost: number, currency: string): string {
		if (result.provider !== "deepseek") return "";
		const ds = result as DeepSeekResult;
		const balance = `${ds.currency === "CNY" ? "¥" : "$"}${ds.totalBalance}`;
		const weekly = ds.weeklyTokens > 0 ? `7d:${fmt(ds.weeklyTokens)}` : "";
		const parts: string[] = [];

		if (sessionCost > 0) {
			parts.push(`${currency}${sessionCost.toFixed(2)}/${balance}`);
		} else {
			parts.push(balance);
		}
		if (weekly) parts.push(weekly);

		return parts.join(" · ");
	}

	formatNotifyMessage(result: NonNullable<ProviderUsageResult>): string {
		if (result.provider !== "deepseek") return "";
		const ds = result as DeepSeekResult;
		const bal = `${ds.currency === "CNY" ? "¥" : "$"}${ds.totalBalance}`;
		const weekly = ds.weeklyTokens > 0 ? ` · 7d: ${fmt(ds.weeklyTokens)}` : "";
		return `Balance: ${bal}${weekly}`;
	}

	debugDump(result: NonNullable<ProviderUsageResult>, w: (s: string) => void): void {
		if (result.provider !== "deepseek") return;
		const ds = result as DeepSeekResult;
		w(`  balance: ${ds.currency} ${ds.totalBalance}`);
		w(`  weeklyTokens: ${ds.weeklyTokens}`);
	}
}
// ---------------------------------------------------------------------------

class ZaiProvider implements UsageProvider {
	async fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult> {
		if (!model || !isZaiProvider(model.provider)) return null;

		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider);
		if (!apiKey) return null;

		const defaultOrigin = model.provider === "zai-coding-cn"
			? "https://open.bigmodel.cn"
			: "https://api.z.ai";
		const origin = getOrigin(model, defaultOrigin);
		const headers = {
			Authorization: apiKey,
			"Accept-Language": "en-US,en",
			"Content-Type": "application/json",
		};

		try {
			// Phase 1: fetch quota limits
			const quota = await this.fetchQuota(origin, headers);
			if (!quota) return null;

			// Phase 2: determine weekly quota source
			const now = Date.now();
			let weeklyTokens = 0;
			let weeklyResetAt = 0;
			let weeklyPct = 0;
			let isNaturalWeek = false;

			if (quota.weeklyResetTime > 0) {
				// unit:6 TOKENS_LIMIT exists — use API percentage + model-usage tokens
				weeklyPct = quota.weeklyPct;
				weeklyResetAt = quota.weeklyResetTime;
				const cycleStart = weeklyResetAt - 7 * 24 * 60 * 60 * 1000;
				weeklyTokens = await this.fetchCycleUsage(origin, headers, cycleStart, now);
			} else {
				// No unit:6 — natural week fallback, same as DeepSeek
				isNaturalWeek = true;
				weeklyTokens = scanWeeklyTokens(model.provider);

				const d = new Date(now);
				const dayOfWeek = d.getUTCDay();
				const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
				weeklyResetAt = Date.UTC(
					d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMonday, 0, 0, 0, 0,
				);
			}

			return {
				provider: "zai",
				tokensLimitPct: quota.fiveHourPct,
				tokensResetAt: quota.tokensResetTime,
				level: quota.level,
				weeklyTokens,
				weeklyResetAt,
				weeklyPct,
				isNaturalWeek,
			};
		} catch {
			return null;
		}
	}

	formatForFooter(result: NonNullable<ProviderUsageResult>, _sessionCost: number, _currency: string): string {
		if (result.provider !== "zai") return "";
		const zai = result as ZaiResult;
		const parts: string[] = [];

		// 5-hour rolling quota
		const countdown = formatCountdown(zai.tokensResetAt);
		parts.push(`Usage ${zai.tokensLimitPct}%(${countdown})`);

		// Weekly quota
		if (zai.isNaturalWeek) {
			// Natural week — same format as DeepSeek
			if (zai.weeklyTokens > 0) {
				parts.push(`7d:${fmt(zai.weeklyTokens)}`);
			}
		} else if (zai.weeklyTokens > 0 || zai.weeklyPct > 0) {
			// unit:6 API weekly quota — show percentage + tokens + countdown
			const weeklyCountdown = formatWeeklyCountdown(zai.weeklyResetAt);
			parts.push(`W:${zai.weeklyPct}%(${fmt(zai.weeklyTokens)},${weeklyCountdown})`);
		}

		return parts.join(" · ");
	}

	formatNotifyMessage(result: NonNullable<ProviderUsageResult>): string {
		if (result.provider !== "zai") return "";
		const zai = result as ZaiResult;
		const countdown = formatCountdown(zai.tokensResetAt);
		const usage = `Usage ${zai.tokensLimitPct}%(${countdown})`;

		if (zai.isNaturalWeek) {
			const weekly = zai.weeklyTokens > 0 ? ` · 7d: ${fmt(zai.weeklyTokens)}` : "";
			return `${usage}${weekly}`;
		}
		const weeklyCountdown = formatWeeklyCountdown(zai.weeklyResetAt);
		return `${usage} · W:${zai.weeklyPct}%(${fmt(zai.weeklyTokens)},${weeklyCountdown})`;
	}

	debugDump(result: NonNullable<ProviderUsageResult>, w: (s: string) => void): void {
		if (result.provider !== "zai") return;
		const zai = result as ZaiResult;
		w(`  tokensLimitPct: ${zai.tokensLimitPct}%`);
		w(`  tokensResetAt: ${new Date(zai.tokensResetAt).toISOString()}`);
		w(`  level: ${zai.level}`);
		w(`  weeklyTokens: ${zai.weeklyTokens}`);
		w(`  weeklyPct: ${zai.weeklyPct}%`);
		w(`  isNaturalWeek: ${zai.isNaturalWeek}`);
		w(`  weeklyResetAt: ${zai.weeklyResetAt ? new Date(zai.weeklyResetAt).toISOString() : "?"}`);
	}

	// ---- Private helpers ----

	/** Fetch quota limits from API. Returns parsed data or null. */
	private async fetchQuota(
		origin: string,
		headers: Record<string, string>,
	): Promise<{
			fiveHourPct: number;
			tokensResetTime: number;
			weeklyPct: number;
			weeklyResetTime: number;
			level: string;
		} | null> {
		const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
			headers,
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;

		const json = (await res.json()) as QuotaResponse;
		const limits = json.data?.limits ?? [];

		// unit:3 = 5-hour rolling, unit:6 = weekly
		const fiveHourLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 3);
		const weeklyLimit = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 6);

		return {
			fiveHourPct: fiveHourLimit?.percentage ?? 0,
			tokensResetTime: fiveHourLimit?.nextResetTime ?? 0,
			weeklyPct: weeklyLimit?.percentage ?? 0,
			weeklyResetTime: weeklyLimit?.nextResetTime ?? 0,
			level: json.data?.level ?? "",
		};
	}

	/** Fetch model-usage for a time range. Returns total tokens. */
	private async fetchCycleUsage(
		origin: string,
		headers: Record<string, string>,
		cycleStartMs: number,
		nowMs: number,
	): Promise<number> {
		try {
			const start = formatTimestamp(new Date(cycleStartMs));
			const end = formatTimestamp(new Date(nowMs));
			const url = `${origin}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}`;
			const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
			if (!res.ok) return 0;

			const json = (await res.json()) as { data?: ModelUsageData };
			return extractTotalTokens(json?.data);
		} catch {
			return 0;
		}
	}
}

// ---------------------------------------------------------------------------
// Provider registry and cache (Task 5)
// ---------------------------------------------------------------------------

const providers: Record<string, UsageProvider> = {
	deepseek: new DeepSeekProvider(),
	zai: new ZaiProvider(),
	"zai-coding-cn": new ZaiProvider(),
};

let usageCache: { result: ProviderUsageResult; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshUsage(
	modelRegistry: ExtensionContext["modelRegistry"],
	model: ExtensionContext["model"],
): Promise<ProviderUsageResult> {
	const providerName = model?.provider ?? "";
	const provider = providers[providerName];
	if (!provider) {
		usageCache = null;
		return null;
	}

	const result = await provider.fetchUsage(modelRegistry, model);
	if (result) {
		usageCache = { result, fetchedAt: Date.now() };
	} else {
		usageCache = null;
	}
	return result;
}

function getCachedUsage(): ProviderUsageResult {
	if (!usageCache) return null;
	if (Date.now() - usageCache.fetchedAt > CACHE_TTL_MS) {
		// TTL expired: return stale data but trigger background refresh
		if (lastCtx && lastModel) {
			void refreshUsage(lastCtx.modelRegistry, lastModel);
		}
	}
	return usageCache.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as "YYYY-MM-DD HH:mm:ss" for API query params. */
function formatTimestamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmt(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

function formatDuration(sec: number): string {
	if (sec < 60) return `${Math.floor(sec)}s`;
	const min = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${min}m${s}s`;
}

/** Extract total tokens from model-usage API response. Handles both formats:
 *  1. Object: data.totalUsage.totalTokensUsage (bigmodel.cn)
 *  2. Object: data.modelSummaryList[].totalTokens sum
 *  3. Array:  data[].totalTokens sum (z.ai / older API)
 */
function extractTotalTokens(data: unknown): number {
	if (!data) return 0;

	if (Array.isArray(data)) {
		return (data as Array<{ totalTokens?: number }>).reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
	}

	if (typeof data === "object") {
		const obj = data as {
			totalUsage?: { totalTokensUsage?: number };
			modelSummaryList?: Array<{ totalTokens?: number }>;
		};
		if (obj.totalUsage && typeof obj.totalUsage.totalTokensUsage === "number") {
			return obj.totalUsage.totalTokensUsage;
		}
		if (Array.isArray(obj.modelSummaryList)) {
			return obj.modelSummaryList.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
		}
	}

	return 0;
}

function formatCountdown(resetAt: number): string {
	if (!resetAt) return "?";
	const remainingMs = resetAt - Date.now();
	if (remainingMs <= 0) return "0m";
	const totalMin = Math.floor(remainingMs / 60000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

/** Format countdown with day precision for weekly cycles. */
function formatWeeklyCountdown(resetAt: number): string {
	if (!resetAt) return "?";
	const remainingMs = resetAt - Date.now();
	if (remainingMs <= 0) return "0h";
	const totalMin = Math.floor(remainingMs / 60000);
	const d = Math.floor(totalMin / 1440);
	const h = Math.floor((totalMin % 1440) / 60);
	if (d > 0) return `${d}d${h}h`;
	const m = totalMin % 60;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

/** Live elapsed time if agent is running, otherwise frozen from last turn. */
function getElapsedSec(): number {
	if (agentRunning && agentStartMs !== null) return (Date.now() - agentStartMs) / 1000;
	return lastElapsedSec;
}

function formatCwd(cwd: string): string {
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

function computeSessionStats(ctx: ExtensionContext) {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, total = 0, cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cacheRead += m.usage.cacheRead;
			cacheWrite += m.usage.cacheWrite;
			total += m.usage.totalTokens;
			cost += m.usage.cost.total;
		}
	}

	const hitRate = input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0;

	let currency: "¥" | "$" = "$";
	if (currencyOverride) {
		currency = currencyOverride;
	} else {
		const p = ctx.model?.provider ?? "";
		if (p.toLowerCase().includes("deepseek")) currency = "¥";
	}

	return { input, output, cacheRead, cacheWrite, total, cost, currency, hitRate };
}

// ---------------------------------------------------------------------------
// Threshold-based coloring
// ---------------------------------------------------------------------------

/**
 * Color a string based on usage severity.
 *
 * Two thresholds, three states – simple and intentional:
 *   < 75%  dim      – normal, nothing to see
 *   ≥ 75%  warning  – yellow, start paying attention
 *   ≥ 85%  error    – red, act now
 *
 * Why not 60%?  At 60% context usage the model is fine; warning that early
 * creates alert fatigue and teaches the developer to ignore the statusline.
 * Why not 95%?  Context compression triggers automatically before that point,
 * so a red warning at 95% is redundant.
 */
function colorForPct(theme: Theme, pct: number): (s: string) => string {
	if (pct >= 85) return (s) => theme.fg("error", s);
	if (pct >= 75) return (s) => theme.fg("warning", s);
	return (s) => theme.fg("dim", s);
}

// ---------------------------------------------------------------------------
// Task 6: Refactored buildStatLine
// ---------------------------------------------------------------------------

function buildStatLine(
	stats: ReturnType<typeof computeSessionStats>,
	contextUsage: ContextUsage | undefined,
	providerResult: ProviderUsageResult,
	theme: Theme,
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const sep = dim(" · ");
	const mods: string[] = [];

	// tokens 566k(in 29k, out 22k, cache 515k, 45.2%)
	{
		const tok: string[] = [];
		if (stats.input) tok.push(`in ${fmt(stats.input)}`);
		if (stats.output) tok.push(`out ${fmt(stats.output)}`);
		const cache = stats.cacheRead + stats.cacheWrite;
		if (cache) {
			const cacheStr = stats.hitRate > 0
				? `cache ${fmt(cache)},${(stats.hitRate * 100).toFixed(1)}%`
				: `cache ${fmt(cache)}`;
			tok.push(cacheStr);
		}
		if (tok.length > 0 && stats.total) {
			mods.push(dim(`tokens ${fmt(stats.total)}(${tok.join(", ")})`));
		} else if (tok.length > 0) {
			mods.push(dim(tok.join(", ")));
		}
	}

	// Provider-specific cost/usage – colored inline from structured data
	if (providerResult?.provider === "zai") {
		const zai = providerResult as ZaiResult;
		const parts: string[] = [];

		// 5-hour rolling quota – the most time-critical indicator
		const countdown = formatCountdown(zai.tokensResetAt);
		parts.push(colorForPct(theme, zai.tokensLimitPct)(`Usage ${zai.tokensLimitPct}%(${countdown})`));

		// Weekly quota
		if (!zai.isNaturalWeek && (zai.weeklyTokens > 0 || zai.weeklyPct > 0)) {
			const wc = formatWeeklyCountdown(zai.weeklyResetAt);
			parts.push(colorForPct(theme, zai.weeklyPct)(`W:${zai.weeklyPct}%(${fmt(zai.weeklyTokens)},${wc})`));
		} else if (zai.weeklyTokens > 0) {
			parts.push(dim(`7d:${fmt(zai.weeklyTokens)}`));
		}

		// Session cost (ZAI doesn't show it on its own, only combined)
		if (stats.cost > 0) {
			parts.push(dim(`${stats.currency}${stats.cost.toFixed(2)}`));
		}

		mods.push(parts.join(sep));
	} else if (providerResult?.provider === "deepseek") {
		// DeepSeek: no percentage-based quota, delegate to provider
		const provider = providers["deepseek"];
		const formatted = provider.formatForFooter(providerResult, stats.cost, stats.currency);
		if (formatted) mods.push(dim(formatted));
	} else if (stats.cost > 0) {
		mods.push(dim(`${stats.currency}${stats.cost.toFixed(2)}`));
	}

	// Context window – color by usage percent
	if (contextUsage) {
		const w = fmt(contextUsage.contextWindow);
		if (contextUsage.percent !== null) {
			mods.push(colorForPct(theme, contextUsage.percent)(`${contextUsage.percent.toFixed(1)}%/${w}`));
		} else {
			mods.push(dim(`?/${w}`));
		}
	}

	// timing:  2m30s 39.5 tok/s
	{
		const t: string[] = [];
		const elapsed = getElapsedSec();
		if (elapsed > 0) t.push(formatDuration(elapsed));
		if (lastTps > 0) t.push(`${lastTps.toFixed(1)}tok/s`);
		if (t.length) mods.push(dim(t.join(" ")));
	}

	// MCP:  MCP:2(15)  or  MCP:0
	{
		const entries = Array.from(mcpStatuses.entries());
		if (entries.length) {
			const connected = entries.filter(([, s]) => s.connected).length;
			const tools = entries.reduce((sum, [, s]) => sum + s.toolCount, 0);
			mods.push(dim(connected > 0 ? `MCP:${connected}(${tools})` : "MCP:0"));
		}
	}

	return mods.join(sep);
}

function buildInfoLine(modelId: string | undefined, thinkingLevel: string): string {
	const parts: string[] = [];
	if (modelId) parts.push(modelId);
	if (thinkingLevel && thinkingLevel !== "off") parts.push(thinkingLevel);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("agent_start", () => {
		agentStartMs = Date.now();
		agentRunning = true;
	});

	pi.on("agent_end", (event) => {
		agentRunning = false;
		if (agentStartMs === null) return;
		const elapsedMs = Date.now() - agentStartMs;
		if (elapsedMs <= 0) return;
		lastElapsedSec += elapsedMs / 1000;

		// Compute cumulative output tokens from all assistant messages in the session
		let cumulativeOutput = 0;
		if (lastCtx) {
			for (const entry of lastCtx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					cumulativeOutput += (entry.message as AssistantMessage).usage.output;
				}
			}
		} else {
			// fallback: use current turn's messages when no session context
			for (const m of event.messages) {
				if (m.role === "assistant") cumulativeOutput += (m as AssistantMessage).usage.output;
			}
		}
		lastTps = cumulativeOutput > 0 ? cumulativeOutput / lastElapsedSec : 0;

		// Schedule background refresh to pick up new usage data
		if (lastCtx && lastModel) {
			void refreshUsage(lastCtx.modelRegistry, lastModel);
		}
	});

	pi.events.on("mcp:status", (raw) => {
		const data = raw as { id: string; connected: boolean; toolCount: number };
		mcpStatuses.set(data.id, { connected: data.connected, toolCount: data.toolCount });
	});
	pi.events.on("mcp:disconnect", (raw) => {
		mcpStatuses.delete((raw as { id: string }).id);
	});

	// ---- /status-debug (Task 8) ----
	pi.registerCommand("status-debug", {
		description: "Dump session stats to /tmp/pi-status-debug.log + console.error",
		handler: async (_args, ctx) => {
			const logPath = `${tmpdir()}/pi-status-debug.log`;
			const w = (s: string) => {
				console.error(s);
				try { appendFileSync(logPath, s + "\n"); } catch { /* ok */ }
			};

			w("=== STATUS-LINE DEBUG ===");
			w(`cwd: ${ctx.cwd}`);
			w(`model: ${ctx.model?.provider}/${ctx.model?.id}`);
			w(`thinking: ${pi.getThinkingLevel()}`);

			const cu = ctx.getContextUsage();
			w(`contextUsage: tokens=${cu?.tokens ?? "?"} window=${cu?.contextWindow ?? "?"} percent=${cu?.percent ?? "?"}`);

			// Usage cache dump
			w(`--- provider usage ---`);
			const cached = getCachedUsage();
			if (cached) {
				w(`  provider: ${cached.provider}`);
				const dbgProvider = providers[cached.provider];
				if (dbgProvider) dbgProvider.debugDump(cached, w);
			} else {
				w(`  (no cached usage data)`);
			}
			w(`  cacheAge: ${usageCache ? `${Math.round((Date.now() - usageCache.fetchedAt) / 1000)}s` : "N/A"}`);

			let idx = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					w(`--- msg[${idx}] ---`);
					w(`  usage: ${JSON.stringify(m.usage)}`);
					w(`  model: ${m.model}`);
					w(`  cost: ${JSON.stringify(m.usage.cost)}`);
					idx++;
				}
			}

			const stats = computeSessionStats(ctx);
			w(`--- computed ---`);
			w(`  input=${stats.input} output=${stats.output}`);
			w(`  cacheRead=${stats.cacheRead} cacheWrite=${stats.cacheWrite}`);
			w(`  total=${stats.total} cost=${stats.cost} currency=${stats.currency}`);
			w(`  hitRate=${(stats.hitRate * 100).toFixed(1)}%`);
			w("=========================");

			ctx.ui.notify(`Debug written to ${logPath} (${idx} msgs)`, "info");
		},
	});

	// ---- /currency ----
	pi.registerCommand("currency", {
		description: "Toggle cost currency (auto / ¥ / $)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "auto" || a === "") {
				currencyOverride = undefined;
				ctx.ui.notify("Currency: auto (deepseek→¥)", "info");
			} else if (a === "¥" || a === "rmb" || a === "cny") {
				currencyOverride = "¥";
				ctx.ui.notify("Currency: ¥", "info");
			} else if (a === "$" || a === "usd") {
				currencyOverride = "$";
				ctx.ui.notify("Currency: $", "info");
			} else {
				ctx.ui.notify("Usage: /currency [auto|¥|$]", "warning");
			}
		},
	});

	// ---- Model switch: refresh usage when provider changes ----
	pi.on("model_select", (event) => {
		if (lastCtx) {
			lastModel = event.model;
			void refreshUsage(lastCtx.modelRegistry, event.model);
		}
	});

	// ---- Footer (Task 7) ----
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Reset cumulative timing for new session
		lastElapsedSec = 0;
		lastTps = 0;

		// Prime usage cache on startup (non-blocking)
		lastCtx = ctx;
		lastModel = ctx.model;
		void refreshUsage(ctx.modelRegistry, ctx.model);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const stats = computeSessionStats(ctx);
					const cu = ctx.getContextUsage();
					const model = ctx.model;
					const level = pi.getThinkingLevel();
					const providerResult = getCachedUsage();
					const dim = (s: string) => theme.fg("dim", s);
					const lines: string[] = [];

					// Line 0: cwd + git branch (left)  |  model · thinking (right)
					let pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const left = dim(pwd);
					const right = dim(buildInfoLine(model?.id, level));
					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					if (leftW + rightW + 2 <= width) {
						const pad = " ".repeat(width - leftW - rightW);
						lines.push(left + pad + right);
					} else {
						lines.push(truncateToWidth(left + "  " + right, width, dim("...")));
					}

					// Line 1: tokens + cost + provider usage + context + elapsed + tps + mcp
					lines.push(truncateToWidth(buildStatLine(stats, cu, providerResult, theme), width, dim("...")));

					// Line 2: extension statuses (MCP etc.)
					const extStatuses = footerData.getExtensionStatuses();
					if (extStatuses.size > 0) {
						const text = Array.from(extStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(text, width, dim("...")));
					}

					return lines;
				},
			};
		});
	});
}
