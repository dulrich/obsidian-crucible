import type { Provider, ProviderModelCapability, ProviderModelRef } from '../types';

/**
 * WP-rem-R4 (F4): the "every configured model with this capability" collectors the Orchestrate
 * tab's Search panel uses to build its model-picker option lists (`sections/orchestrationSearch.ts`).
 * Pure functions of `Provider[]` — no `CrucibleSettingTab` — so they are importable/testable
 * without the settings pane's Obsidian/runtime graph, same rationale as `providerRefs.ts` and
 * `modelCapabilities.ts`.
 */
export function collectModelRefsByCapability(providers: Provider[], capability: ProviderModelCapability): ProviderModelRef[] {
	const refs: ProviderModelRef[] = [];
	for (const provider of providers) {
		for (const model of provider.models ?? []) {
			if (model.capabilities?.includes(capability)) {
				refs.push({ providerId: provider.id, modelId: model.id });
			}
		}
	}
	return refs;
}

export function embeddingModelRefs(providers: Provider[]): ProviderModelRef[] {
	return collectModelRefsByCapability(providers, 'embedding');
}

export function rerankModelRefs(providers: Provider[]): ProviderModelRef[] {
	return collectModelRefsByCapability(providers, 'rerank');
}

export function imageExtractionModelRefs(providers: Provider[]): ProviderModelRef[] {
	return collectModelRefsByCapability(providers, 'image-extraction');
}
