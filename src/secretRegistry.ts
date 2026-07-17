import type CruciblePlugin from './main';
import { YOUTUBE_DATA_API_SECRET_KEY } from './orchestration/utils/youtubeApi';
import { providerSecretKey } from './providers';

// Every secret this plugin stores is namespaced with this prefix, so a global
// `listSecrets()` can be filtered down to just ours.
export const CRUCIBLE_SECRET_PREFIX = 'crucible-';

export interface SecretReconcileResult {
	// Registry keys absent from the live store — saved once, now gone.
	missing: string[];
	// Crucible keys currently present in the store.
	present: string[];
}

// Pure core: given the persisted registry and the crucible keys currently in the
// store, return the merged registry (grown by observation) and the missing keys.
// Kept separate from the plugin so it is unit-testable without Obsidian.
export function computeReconcile(
	registry: readonly string[],
	liveCrucibleKeys: readonly string[],
): { merged: string[]; result: SecretReconcileResult } {
	const present = Array.from(new Set(liveCrucibleKeys));
	const merged = Array.from(new Set([...registry, ...present]));
	const presentSet = new Set(present);
	const missing = merged.filter(k => !presentSet.has(k));
	return { merged, result: { missing, present } };
}

// Human label for a stored secret key, for user-facing warnings.
export function describeSecretKey(plugin: CruciblePlugin, key: string): string {
	if (key === YOUTUBE_DATA_API_SECRET_KEY) return 'YouTube Data API key';
	for (const provider of plugin.settings.providers) {
		if (providerSecretKey(provider.id) === key) return `${provider.name || provider.id} API key`;
	}
	return key;
}

// Tracks which secret keys the plugin has stored so it can warn when one disappears
// out-of-band. The registry holds key NAMES only — never values — persisted in
// settings. It grows by observation on reconcile, so keys stored before this feature
// existed (or via any path) are picked up the first time they are seen present.
export class SecretRegistry {
	constructor(private readonly plugin: CruciblePlugin) {}

	private get keys(): string[] {
		return this.plugin.settings.storedSecretKeys ?? [];
	}

	isRegistered(key: string): boolean {
		return this.keys.includes(key);
	}

	// Note a key as stored (called after a non-empty write). Persists on change.
	async record(key: string): Promise<void> {
		if (!key || this.keys.includes(key)) return;
		this.plugin.settings.storedSecretKeys = [...this.keys, key];
		await this.plugin.saveSettings();
	}

	// Drop a key from the registry on an intentional clear, so it is not later
	// reported missing. Persists on change.
	async forget(key: string): Promise<void> {
		if (!this.keys.includes(key)) return;
		this.plugin.settings.storedSecretKeys = this.keys.filter(k => k !== key);
		await this.plugin.saveSettings();
	}

	// Fold currently-present crucible keys into the registry, then report which
	// registered keys are absent from the live store. Returns null when the store is
	// unavailable — a distinct failure mode (the API is gone, not the keys) that the
	// caller words differently and never treats as "keys wiped".
	async reconcile(): Promise<SecretReconcileResult | null> {
		const storage = this.plugin.app.secretStorage;
		if (!storage) return null;
		let live: string[];
		try {
			live = (await storage.listSecrets()) ?? [];
		} catch {
			return null;
		}
		const liveCrucible = live.filter(k => k.startsWith(CRUCIBLE_SECRET_PREFIX));
		const { merged, result } = computeReconcile(this.keys, liveCrucible);
		if (merged.length !== this.keys.length) {
			this.plugin.settings.storedSecretKeys = merged;
			await this.plugin.saveSettings();
		}
		return result;
	}
}
