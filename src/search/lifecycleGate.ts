import type { SearchHealth } from './types';

export const SEARCH_AUTO_ONLINE_CACHE_MS = 30_000;
export const SEARCH_AUTO_OFFLINE_CACHE_MS = 5 * 60_000;

export type SearchHealthCheck = () => Promise<SearchHealth | null>;

export class SearchAutoIndexGate {
	private layoutReady = false;
	private metadataResolved = false;
	private onlineUntil = 0;
	private offlineUntil = 0;
	private inFlightHealth: Promise<boolean> | null = null;

	constructor(private readonly now: () => number = () => Date.now()) {}

	markLayoutReady(): void {
		this.layoutReady = true;
	}

	markMetadataResolved(): void {
		this.metadataResolved = true;
	}

	isReady(): boolean {
		return this.layoutReady && this.metadataResolved;
	}

	async companionAvailable(healthCheck: SearchHealthCheck): Promise<boolean> {
		const now = this.now();
		if (this.onlineUntil > now) return true;
		if (this.offlineUntil > now) return false;
		if (this.inFlightHealth) return await this.inFlightHealth;

		const check = this.checkCompanion(healthCheck);
		this.inFlightHealth = check;
		try {
			return await check;
		} finally {
			if (this.inFlightHealth === check) this.inFlightHealth = null;
		}
	}

	private async checkCompanion(healthCheck: SearchHealthCheck): Promise<boolean> {
		const health = await healthCheck().catch(() => null);
		const ok = health?.ok === true;
		const now = this.now();
		if (ok) {
			this.onlineUntil = now + SEARCH_AUTO_ONLINE_CACHE_MS;
			this.offlineUntil = 0;
		} else {
			this.offlineUntil = now + SEARCH_AUTO_OFFLINE_CACHE_MS;
			this.onlineUntil = 0;
		}
		return ok;
	}
}
