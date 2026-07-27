import type { Agent, CrucibleSettings, Provider, ProviderModelRef } from '../types';

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
 * Chain steps deliberately re-implement the tiny parse `agents.ts`'s (unexported) `parseModelRef`
 * also does, rather than importing it: that function exists for `AgentRunner`'s own execution-time
 * caller, and importing it here would drag this leaf module through `agents.ts`'s full
 * `ChainManager`/`ProviderManager`/`ModelPickerModal` dependency graph (and every Obsidian class
 * those touch) just for an 8-line string split. Keep `parseChainStepModelRef` in sync with
 * `agents.ts`'s `parseModelRef` if the `"providerId:modelId"` format ever changes.
 */
export function providerRefsPointingAt(settings: CrucibleSettings, provider: Provider): string[] {
	const labels: string[] = [];
	const pointsHere = (ref: ProviderModelRef | undefined) => !!ref && ref.providerId === provider.id;

	if (pointsHere(settings.searchEmbeddingModel)) labels.push('search embedding');
	if (pointsHere(settings.searchRerankModel)) labels.push('search reranker');
	if (pointsHere(settings.imageMetadataExtractionModel)) labels.push('image description model');

	const agentCount = (settings.agents ?? []).filter(agent => agentReferencesProvider(agent, provider.id)).length;
	if (agentCount > 0) labels.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);

	let chainStepCount = 0;
	for (const chain of settings.chains ?? []) {
		for (const step of chain.steps ?? []) {
			const ref = parseChainStepModelRef(step.args?.model);
			if (ref && ref.providerId === provider.id) chainStepCount++;
		}
	}
	if (chainStepCount > 0) labels.push(`${chainStepCount} chain step${chainStepCount === 1 ? '' : 's'}`);

	return labels;
}

function agentReferencesProvider(agent: Agent, providerId: string): boolean {
	const binding = agent.modelBinding;
	if (!binding) return false;
	if (binding.mode === 'pinned') return binding.pinned?.providerId === providerId;
	if (binding.mode === 'constrained') return (binding.allow ?? []).some(ref => ref.providerId === providerId);
	return false;
}

// Mirrors agents.ts's (unexported) parseModelRef — see this file's header comment for why it's a
// separate copy rather than an import.
function parseChainStepModelRef(raw: string | undefined): ProviderModelRef | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const sep = trimmed.indexOf(':');
	if (sep === -1) return null;
	const providerId = trimmed.slice(0, sep).trim();
	const modelId = trimmed.slice(sep + 1).trim();
	if (!providerId || !modelId) return null;
	return { providerId, modelId };
}
