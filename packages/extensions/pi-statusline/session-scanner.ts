import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { startOfCurrentWeekLocal } from "./week.ts";

export function scanWeeklyTokens(providerName: string): number {
	const sessionsDir = join(getAgentDir(), "sessions");
	// Natural week: Monday 00:00 local time
	const weekStartMs = startOfCurrentWeekLocal();

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
				try {
					const fileDate = new Date(fname.slice(0, 10) + "T00:00:00Z");
					if (fileDate.getTime() < weekStartMs) continue;
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
