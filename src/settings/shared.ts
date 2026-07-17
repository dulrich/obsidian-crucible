import { Setting, setIcon, ExtraButtonComponent, TextComponent } from "obsidian";
import { Provider, ProviderKind, ProviderModelRef } from "../types";

/** A SearchComponent exposes its wrapping element as `containerEl` at runtime. */
export interface SearchWithContainer {
	containerEl: HTMLElement;
}

export interface TemplateVariableInfo {
	token: string;
	description: string;
	example: string;
}

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	google: 'Google (Gemini)',
	openrouter: 'OpenRouter',
	ollama: 'Ollama (Local API)',
	'openai-compatible': 'OpenAI-Compatible (Local)',
	'gemini-cli': 'Gemini CLI',
	'claude-cli': 'Claude Code CLI',
	'codex-cli': 'OpenAI Codex CLI',
	'opencode-cli': 'OpenCode CLI',
};

export function sortByNameWithEmptyLast<T>(items: T[], getName: (item: T) => string): { item: T; index: number }[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const an = getName(a.item) || '';
			const bn = getName(b.item) || '';
			if (!an && bn) return 1;
			if (an && !bn) return -1;
			return an.localeCompare(bn);
		});
}

export function defaultCliCommand(kind: ProviderKind): string {
	switch (kind) {
		case 'gemini-cli': return 'gemini';
		case 'claude-cli': return 'claude';
		case 'codex-cli': return 'codex';
		case 'opencode-cli': return 'opencode';
		default: return '';
	}
}

export function modelIdPlaceholder(kind: ProviderKind): string {
	switch (kind) {
		case 'openai': return 'gpt-4o';
		case 'anthropic': return 'claude-3-5-sonnet-latest';
		case 'google': return 'gemini-1.5-pro';
		case 'openrouter': return 'anthropic/claude-3.5-sonnet';
		case 'ollama': return 'llama3';
		case 'gemini-cli': return 'gemini-2.5-pro';
		case 'claude-cli': return 'claude-sonnet-4-5';
		case 'codex-cli': return 'gpt-5';
		case 'opencode-cli': return 'anthropic/claude-sonnet-4-5';
		default: return '';
	}
}

export function collectAllRefs(providers: Provider[]): ProviderModelRef[] {
	const refs: ProviderModelRef[] = [];
	for (const provider of providers) {
		for (const model of provider.models ?? []) {
			refs.push({ providerId: provider.id, modelId: model.id });
		}
	}
	return refs;
}

/** Grow a textarea to fit its content. */
export function autoSize(el: HTMLTextAreaElement): void {
	el.setCssProps({ height: 'auto' });
	el.setCssProps({ height: `${el.scrollHeight}px` });
}

export function addWarningIcon(el: HTMLElement, tooltip: string): void {
	const icon = el.createSpan({ cls: 'crucible-warning-icon' });
	icon.setAttr('aria-label', tooltip);
	icon.setAttr('title', tooltip);
	setIcon(icon, 'triangle-alert');
}

/**
 * Mount a secret input that swaps between a password field and a "stored" indicator
 * with a clear button. Used for API keys held in Obsidian Secret Storage.
 */
export function mountSecretControl(setting: Setting, opts: {
	placeholder?: string;
	indicatorText?: string;
	load: () => Promise<string>;
	store: (value: string) => Promise<void>;
	clear: () => Promise<void>;
	// True when this key was previously saved but now reads empty — i.e. it vanished
	// from the store out-of-band. Renders a warning state prompting re-entry.
	expectedButMissing?: () => boolean;
}): void {
	const placeholder = opts.placeholder ?? 'Enter API key...';
	const indicatorText = opts.indicatorText ?? 'API Key in Obsidian Secrets';
	const wrapper = setting.controlEl.createDiv({ cls: 'crucible-secret-control' });

	const renderIndicator = () => {
		wrapper.empty();
		wrapper.createSpan({ text: indicatorText, cls: 'crucible-secret-indicator-text' });
		new ExtraButtonComponent(wrapper)
			.setIcon('trash')
			.setTooltip('Clear API key')
			.onClick(async () => {
				await opts.clear();
				renderInput(true);
			});
	};

	const renderInput = (focus = false, missing = false) => {
		wrapper.empty();
		if (missing) {
			wrapper.createSpan({
				text: 'Was saved but now missing — re-enter',
				cls: 'crucible-secret-missing-text',
			});
		}
		const text = new TextComponent(wrapper);
		text.inputEl.type = 'password';
		text.setPlaceholder(placeholder);
		text.inputEl.addClass('pi-width-normal');
		if (missing) text.inputEl.addClass('crucible-secret-missing-input');
		text.onChange(async (v) => { await opts.store(v); });
		text.inputEl.addEventListener('blur', () => {
			if (text.inputEl.value) renderIndicator();
		});
		if (focus) text.inputEl.focus();
	};

	renderInput();
	void opts.load().then(value => {
		if (value) renderIndicator();
		else if (opts.expectedButMissing?.()) renderInput(false, true);
	});
}
