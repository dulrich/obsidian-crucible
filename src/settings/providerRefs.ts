import type { CrucibleSettings, Provider, ProviderModelRef } from '../types';
import { bindingModelRefs, normalizeAgentBinding, parseModelRef } from '../providerModelContract';

/**
 * idh-WP-2: everything a provider is currently used by, collected as short human-readable labels
 * for the Delete-Provider confirmation's in-use summary (`sections/ai.ts`'s `deleteProvider`).
 *
 * Kept as its own obsidian-free pure module rather than folded into `sections/ai.ts` or
 * `shared.ts` — same rationale `modelCapabilities.ts`'s own header comment gives: this is a state
 * question, not a UI one, and wants a unit test that doesn't have to bundle anything Obsidian-ish
 * to reach it. Bundling `sections/ai.ts` directly would need a stub for every Obsidian class it
 * (transitively, via `suggesters.ts`, `modelCatalogBrowser.ts`, `../bind`, `../shared`) touches;
 * `import type`-only dependencies below mean this file needs no stub at all — see
 * `tests/providerRefs.test.mjs`.
 *
 * Covers the five `ProviderModelRef`-shaped (or ref-string-shaped) surfaces a provider delete can
 * orphan: the two search model settings, the image-description model setting, agents'
 * `modelBinding` (both `pinned` and `constrained`/`allow`), and chain steps' `args.model` override
 * string (`"providerId:modelId"`).
 *
 * The ref parser and the binding shape both come from `../providerModelContract`, which is a leaf
 * for exactly this reason — this file used to carry its own `parseChainStepModelRef` copy with a
 * keep-in-sync note attached, because the canonical parser was private to `agents.ts` and importing
 * it dragged the whole `ChainManager`/`ProviderManager`/`ModelPickerModal` graph along.
 */
export function providerRefsPointingAt(settings: CrucibleSettings, provider: Provider): string[] {
	const labels: string[] = [];
	const pointsHere = (ref: ProviderModelRef | undefined) => !!ref && ref.providerId === provider.id;

	if (pointsHere(settings.searchEmbeddingModel)) labels.push('search embedding');
	if (pointsHere(settings.searchRerankModel)) labels.push('search reranker');
	if (pointsHere(settings.imageMetadataExtractionModel)) labels.push('image description model');

	// Normalized on read rather than trusted: this function is also reachable from tests and from
	// settings data that predates the migration pass in `main.ts`, and `bindingModelRefs` is total
	// only over the normalized union.
	const agentCount = (settings.agents ?? [])
		.filter(agent => bindingModelRefs(normalizeAgentBinding(agent.modelBinding))
			.some(ref => ref.providerId === provider.id))
		.length;
	if (agentCount > 0) labels.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);

	let chainStepCount = 0;
	for (const chain of settings.chains ?? []) {
		for (const step of chain.steps ?? []) {
			const ref = parseModelRef(step.args?.model);
			if (ref && ref.providerId === provider.id) chainStepCount++;
		}
	}
	if (chainStepCount > 0) labels.push(`${chainStepCount} chain step${chainStepCount === 1 ? '' : 's'}`);

	return labels;
}
