/**
 * pi-peon-ping — peon-ping adapter for pi
 *
 * Routes pi ExtensionAPI lifecycle events through peon.sh, giving pi users
 * access to ALL peon-ping features:
 * - Sound packs & rotation (Warcraft, StarCraft, Portal, etc.)
 * - Desktop notifications
 * - Trainer reminders (pushups, squats, etc.)
 * - Spam detection
 * - SSH/devcontainer relay
 * - All config options via `peon` CLI
 * - Tab title updates
 *
 * Event mapping (pi ExtensionAPI → peon.sh hook_event_name):
 *   session_start                       → SessionStart
 *   turn_start                          → UserPromptSubmit
 *   turn_end                            → Stop
 *   tool_result (event.isError === true) → PostToolUseFailure
 *   session_shutdown                    → SessionEnd
 *
 * peon.sh discovery (first match wins):
 *   1. $PEON_SH env var (explicit override)
 *   2. brew --prefix peon-ping (macOS Homebrew)
 *   3. ~/.claude/hooks/peon-ping/peon.sh (curl installer, Linux/macOS)
 *   4. ~/.openpeon/hooks/peon-ping/peon.sh (tool-agnostic install)
 *   5. ~/.openclaw/hooks/peon-ping/peon.sh (OpenClaw install)
 *   6. ~/.claude/hooks/peon-ping/peon.ps1 (Windows/Git Bash WSL2 fallback)
 *
 * Requires peon-ping installed:
 *   brew install PeonPing/tap/peon-ping
 *   # or: curl -fsSL peonping.com/install | bash
 *
 * Based on the oh-my-pi (omp) adapter from:
 *   https://github.com/PeonPing/peon-ping/tree/main/adapters/omp
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

/** Template paths for peon.sh discovery. $HOME is resolved at runtime. */
export const PEON_SH_TEMPLATES = [
	// Homebrew (macOS)
	"$(brew --prefix peon-ping)/libexec/peon.sh",
	// curl installer default (Linux/macOS)
	"$HOME/.claude/hooks/peon-ping/peon.sh",
	// --openpeon mode (tool-agnostic root)
	"$HOME/.openpeon/hooks/peon-ping/peon.sh",
	// OpenClaw install
	"$HOME/.openclaw/hooks/peon-ping/peon.sh",
	// Windows/Git Bash WSL2 fallback
	"$HOME/.claude/hooks/peon-ping/peon.ps1",
];

// ============================================================================
// peon.sh discovery
// ============================================================================

export function resolvePeonShPaths(): string[] {
	const home = homedir();
	return PEON_SH_TEMPLATES.map((t) => t.replace("$HOME", home));
}

/**
 * Try to resolve the Homebrew peon-ping prefix.
 * Returns the libexec/peon.sh path, or undefined if brew is unavailable.
 */
export function tryBrewPrefix(): string | undefined {
	if (platform() !== "darwin") return undefined;
	try {
		const prefix = execFileSync("brew", ["--prefix", "peon-ping"], {
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!prefix) return undefined;
		const shPath = join(prefix, "libexec", "peon.sh");
		return existsSync(shPath) ? shPath : undefined;
	} catch {
		return undefined;
	}
}

export function findPeonSh(): string | null {
	// 1. PEON_SH env var override
	const envPath = process.env.PEON_SH;
	if (envPath) {
		try {
			if (existsSync(envPath)) return envPath;
		} catch {
			// permission denied
		}
	}

	// 2. Homebrew prefix (macOS only)
	const brewPath = tryBrewPrefix();
	if (brewPath) return brewPath;

	// 3-6. Static paths
	for (const p of resolvePeonShPaths()) {
		try {
			if (existsSync(p)) return p;
		} catch {
			// permission denied or other fs error
		}
	}
	return null;
}

// ============================================================================
// Shell detection
// ============================================================================

/**
 * Returns the shell command to use for spawning peon.
 * On Windows (Git Bash / WSL2), peon.sh may be peon.ps1 and needs powershell.
 */
export function resolveShellAndScript(
	peonPath: string,
): { shell: string; script: string } {
	if (peonPath.endsWith(".ps1")) {
		return { shell: "powershell", script: peonPath };
	}
	return { shell: "bash", script: peonPath };
}

// ============================================================================
// Terminal tab title helpers
// ============================================================================

export function setTabTitle(title: string): void {
	process.stdout.write(`\x1b]0;${title}\x07`);
}

// ============================================================================
// Session ID helpers
// ============================================================================

export function getSessionId(ctx: ExtensionContext): string {
	try {
		const sm = ctx.sessionManager as { getSessionFile?: () => string | undefined };
		const file = sm.getSessionFile?.();
		if (file) return file;
	} catch {
		// session manager not available
	}
	return `pi-${Date.now()}`;
}

// ============================================================================
// peon.sh invocation
// ============================================================================

export function firePeon(
	peonPath: string,
	event: string,
	cwd: string,
	sessionId: string,
): void {
	const payload = JSON.stringify({
		hook_event_name: event,
		notification_type: "",
		cwd,
		session_id: sessionId,
		permission_mode: "",
		source: "pi",
	});

	try {
		const { shell, script } = resolveShellAndScript(peonPath);
		const proc = spawn(shell, [script], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		proc.stdin.write(payload);
		proc.stdin.end();
		proc.unref();
	} catch {
		// best-effort, silently ignore
	}
}

// ============================================================================
// Extension
// ============================================================================

export default function peonPingExtension(pi: ExtensionAPI): void {
	const peonPath = findPeonSh();
	if (!peonPath) {
		console.warn("[pi-peon-ping] peon.sh not found. Install peon-ping first:");
		console.warn("  brew install PeonPing/tap/peon-ping");
		console.warn("  # or: curl -fsSL peonping.com/install | bash");
		console.warn("  # or: set PEON_SH=/path/to/peon.sh");
		return;
	}

	const cwd = process.cwd();
	const projectName = basename(cwd) || "pi";

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		if (ctx.hasUI) setTabTitle(`● ${projectName}: ready`);
		firePeon(peonPath, "SessionStart", cwd, sessionId);
	});

	pi.on("turn_start", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		if (ctx.hasUI) setTabTitle(`● ${projectName}: working...`);
		firePeon(peonPath, "UserPromptSubmit", cwd, sessionId);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		if (ctx.hasUI) setTabTitle(`✓ ${projectName}: done`);
		firePeon(peonPath, "Stop", cwd, sessionId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!event.isError) return;
		const sessionId = getSessionId(ctx);
		if (ctx.hasUI) setTabTitle(`✗ ${projectName}: error`);
		firePeon(peonPath, "PostToolUseFailure", cwd, sessionId);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		firePeon(peonPath, "SessionEnd", cwd, sessionId);
	});
}
