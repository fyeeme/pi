import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageResult } from "../types.ts";
import type { QuotaCalculator } from "../quota/types.ts";

export interface UsageProvider {
	fetchUsage(
		modelRegistry: ExtensionContext["modelRegistry"],
		model: ExtensionContext["model"],
	): Promise<ProviderUsageResult>;
	formatForFooter(result: NonNullable<ProviderUsageResult>, sessionCost: number, currency: string): string;
	quotaCalculator: QuotaCalculator;
}
