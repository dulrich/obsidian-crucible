import { ProviderModel, ProviderModelCapability } from '../types';

/**
 * Reading and writing a provider model's capability flags.
 *
 * These live in their own module rather than inside the settings tab because the whole bug they
 * exist to prevent is a *state* bug, not a UI one, and a state bug wants a unit test that does
 * not have to bundle the settings pane to reach it.
 *
 * The load-bearing distinction: `capabilities === undefined` means "never configured" and reads
 * as chat-only, per the legacy contract documented on `ProviderModel`. An **empty array** is a
 * different statement — the user turned every capability off — and must be honoured as such.
 *
 * Conflating the two is how a Rerank-only model kept regaining Chat across reloads. The toggles
 * write through `setModelCapability`, which re-seeded its Set from `['chat']` whenever the
 * current array was empty, so turning Chat off (leaving `[]`) and then turning Rerank on
 * produced `['chat', 'rerank']` rather than `['rerank']`. The model row is not re-rendered after
 * a toggle, so the Chat switch still *looked* off for the rest of the session and the re-added
 * capability only surfaced on the next reload — which is what made it present as a restart bug
 * rather than a toggle bug. Treating `[]` as chat on the read side compounded it: a model stored
 * as `[]` rendered its Chat toggle on while nothing had been written, so the next toggle of any
 * kind made the lie real.
 */
export function modelHasCapability(model: ProviderModel, capability: ProviderModelCapability): boolean {
	if (!model.capabilities) return capability === 'chat';
	return model.capabilities.includes(capability);
}

export function setModelCapability(model: ProviderModel, capability: ProviderModelCapability, enabled: boolean): void {
	// Seed from the legacy default only when nothing was ever configured — never when the array
	// is present and empty, which is an explicit "no capabilities", not an absence.
	const defaults: ProviderModelCapability[] = ['chat'];
	const next = new Set<ProviderModelCapability>(model.capabilities ?? defaults);
	if (enabled) next.add(capability);
	else next.delete(capability);
	model.capabilities = Array.from(next);
}
