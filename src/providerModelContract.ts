/**
 * The provider/model binding contract: the persisted shapes that say *which* (provider, model)
 * pair a piece of configuration points at, the one string form those pairs travel in
 * (`"providerId:modelId"`), and the single normalization boundary every persisted binding is read
 * through.
 *
 * **This module is a leaf and must stay one.** It imports nothing — not `obsidian`, not `./types`,
 * not `./settings/*`, not any runtime module. That is not tidiness, it is the fix: the parser below
 * previously existed in three places (`agents.ts`'s private `parseModelRef`, `settings/
 * providerRefs.ts`'s `parseChainStepModelRef`, and an inline `indexOf(':')` split in
 * `settings/sections/ai.ts`) purely because the canonical copy lived inside `agents.ts`, and
 * importing it dragged `ChainManager`/`ProviderManager`/`ModelPickerModal` and every Obsidian class
 * behind them into whatever leaf wanted an 8-line string split. `providerRefs.ts`'s header comment
 * used to document that duplication and ask future editors to keep the copies in sync. Anything
 * that can be imported from here instead of re-implemented, must be — and nothing may be added here
 * that would give this file a dependency.
 *
 * `src/types.ts` re-exports the three types below so the ~dozen existing `import { ProviderModelRef
 * } from '../types'` sites keep working; new code should prefer importing from here directly.
 *
 * ## What the discriminated union buys, and what it deliberately does not
 *
 * `AgentModelBinding` used to be `{ mode, pinned?, allow? }` — a mode tag plus two independently
 * optional payload bags. That admitted states the UI and the runtime both had to defend against:
 * a `runtime`-mode binding still carrying stale `pinned` data from before a mode switch, or a
 * `pinned`/`constrained` binding with no payload at all. Each variant below carries exactly its own
 * required payload, so those states are unrepresentable, mode changes must replace the whole
 * variant (`bindingForMode`), and the runtime's missing-payload fallbacks are gone.
 *
 * What the union does NOT claim is that a payload is *finished*. A `pinned` variant's ref may hold
 * empty ids — that is the real, reachable state of a user who has just switched the dropdown to
 * "Pinned" and not yet chosen a provider, and normalization must preserve it rather than silently
 * reinterpret a half-configured agent. Completeness is a separate question, asked with
 * `isCompleteModelRef`, and it stays a runtime check. The structural invariant is: the payload key
 * always exists, always matches the mode, and no foreign payload rides along.
 */

/** A single (provider, model) pair. Ids are opaque strings owned by the provider config. */
export interface ProviderModelRef {
	providerId: string;
	modelId: string;
}

export type AgentBindingMode = 'pinned' | 'constrained' | 'runtime';

/**
 * How an agent chooses its (provider, model) at invocation time.
 * - `pinned`: always this one ref.
 * - `constrained`: the user picks from `allow` when the agent runs.
 * - `runtime`: the user picks from every configured pair when the agent runs.
 */
export type AgentModelBinding =
	| { mode: 'pinned'; pinned: ProviderModelRef }
	| { mode: 'constrained'; allow: ProviderModelRef[] }
	| { mode: 'runtime' };

/**
 * The separator in the `"providerId:modelId"` string form. Model ids routinely contain `:` and `/`
 * themselves (`gemma-4-12b:q8_0`, `openai/text-embedding-3-small`), which is why the parser splits
 * on the FIRST separator only and never on the last — `p1:gemma:q8` is provider `p1`, model
 * `gemma:q8`. Do not "fix" this to `split(':')`.
 */
export const MODEL_REF_SEPARATOR = ':';

/** The string form: what chain steps store in `args.model` and what dropdown option values carry. */
export function formatModelRef(ref: ProviderModelRef): string {
	return `${ref.providerId}${MODEL_REF_SEPARATOR}${ref.modelId}`;
}

/**
 * The one parser. Returns `null` — never a partial ref — for anything that is not a complete
 * `"providerId:modelId"` pair, because every caller of the string form (a chain step's model
 * override, an allowlist dropdown's selected value) is asking "did the user name a specific model?"
 * and a half-answer is a no.
 */
export function parseModelRef(raw: string | null | undefined): ProviderModelRef | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const sep = trimmed.indexOf(MODEL_REF_SEPARATOR);
	if (sep === -1) return null;
	const providerId = trimmed.slice(0, sep).trim();
	const modelId = trimmed.slice(sep + 1).trim();
	if (!providerId || !modelId) return null;
	return { providerId, modelId };
}

/** Whether both halves are filled in — i.e. this ref can actually resolve to a configured model. */
export function isCompleteModelRef(ref: ProviderModelRef): boolean {
	return ref.providerId.length > 0 && ref.modelId.length > 0;
}

export function modelRefEquals(a: ProviderModelRef, b: ProviderModelRef): boolean {
	return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * A fresh, empty variant for `mode` — what a mode-change handler assigns. Assigning a whole variant
 * rather than mutating the `mode` tag is what makes "mode changes drop stale variant data" true by
 * construction instead of by remembering to clean up.
 */
export function bindingForMode(mode: AgentBindingMode): AgentModelBinding {
	switch (mode) {
		case 'pinned':
			return { mode: 'pinned', pinned: { providerId: '', modelId: '' } };
		case 'constrained':
			return { mode: 'constrained', allow: [] };
		case 'runtime':
			return { mode: 'runtime' };
	}
}

/**
 * Every configured (provider, model) pair a binding actually points at — one for `pinned`, the
 * allowlist for `constrained`, none for `runtime`. Incomplete refs are omitted: a half-filled
 * pinned ref names no model, so "which providers does this agent reference?" must not answer with
 * it. Lets callers ask that question without re-switching on the mode.
 */
export function bindingModelRefs(binding: AgentModelBinding): ProviderModelRef[] {
	switch (binding.mode) {
		case 'pinned':
			return isCompleteModelRef(binding.pinned) ? [binding.pinned] : [];
		case 'constrained':
			return binding.allow;
		case 'runtime':
			return [];
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a possibly half-filled ref out of raw persisted JSON. Always returns a ref (fields default
 * to `''`) rather than null, because the pinned variant's payload is required — "the user has not
 * finished configuring" is expressed by empty ids, not by an absent key. The string form is
 * accepted too, since it costs nothing and losing a coherent `"p1:m1"` would be data loss.
 */
function readRef(raw: unknown): ProviderModelRef {
	if (typeof raw === 'string') return parseModelRef(raw) ?? { providerId: '', modelId: '' };
	if (!isRecord(raw)) return { providerId: '', modelId: '' };
	return {
		providerId: typeof raw.providerId === 'string' ? raw.providerId.trim() : '',
		modelId: typeof raw.modelId === 'string' ? raw.modelId.trim() : '',
	};
}

/**
 * Reads an allowlist. Unlike the pinned payload, incomplete entries are DROPPED: an allowlist entry
 * with no model id can never match anything the picker offers, so keeping it would only inflate the
 * "Constrained (N allowed)" count with a row that does nothing. Duplicates collapse (first wins) —
 * the allowlist editor already refuses to add one, so a duplicate only reaches here from
 * hand-edited or corrupted data.
 */
function readAllow(raw: unknown): ProviderModelRef[] {
	if (!Array.isArray(raw)) return [];
	const refs: ProviderModelRef[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const ref = readRef(entry);
		if (!isCompleteModelRef(ref)) continue;
		const key = formatModelRef(ref);
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push(ref);
	}
	return refs;
}

/**
 * The persistence boundary: total (every input produces a valid variant, nothing throws) and
 * conservative (coherent data is carried across, incoherent data falls back to the safest variant
 * rather than being guessed at). Called once per agent during settings migration, so nothing
 * downstream ever sees an unnormalized binding.
 *
 * - A recognized `mode` selects the variant, and only that variant's payload is read — this is what
 *   drops stale `pinned` data left behind in a `runtime`-mode binding by the old in-place mode
 *   mutation.
 * - A missing/unrecognized `mode` is recovered from whatever coherent payload is present (a
 *   complete pinned ref, else a non-empty allowlist, else runtime) rather than discarded, so a
 *   binding whose tag was lost keeps its meaning.
 * - Anything that is not an object at all — `undefined`, `null`, a string, an array, a number —
 *   becomes `runtime`, the variant that requires no configuration and cannot mis-resolve.
 */
export function normalizeAgentBinding(raw: unknown): AgentModelBinding {
	if (!isRecord(raw)) return { mode: 'runtime' };

	switch (raw.mode) {
		case 'pinned':
			return { mode: 'pinned', pinned: readRef(raw.pinned) };
		case 'constrained':
			return { mode: 'constrained', allow: readAllow(raw.allow) };
		case 'runtime':
			return { mode: 'runtime' };
		default: {
			const pinned = readRef(raw.pinned);
			if (isCompleteModelRef(pinned)) return { mode: 'pinned', pinned };
			const allow = readAllow(raw.allow);
			if (allow.length > 0) return { mode: 'constrained', allow };
			return { mode: 'runtime' };
		}
	}
}
