import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import { Provider, ProviderModel, ProviderModelRef } from './types';
import { formatModelRef } from './providerModelContract';

export interface ModelPickerOption {
	provider: Provider;
	model: ProviderModel;
}

export class ModelPickerModal extends FuzzySuggestModal<ModelPickerOption> {
	private picked = false;

	constructor(
		app: App,
		private options: ModelPickerOption[],
		private onPick: (ref: ProviderModelRef) => void,
		private onCancel?: () => void,
	) {
		super(app);
		this.setPlaceholder('Pick a model...');
	}

	getItems(): ModelPickerOption[] {
		return this.options;
	}

	getItemText(item: ModelPickerOption): string {
		const providerLabel = item.provider.name || item.provider.kind;
		const modelLabel = item.model.label || item.model.id;
		return `${providerLabel} · ${modelLabel}`;
	}

	// Obsidian's FuzzySuggestModal.selectSuggestion calls close() before onChooseSuggestion,
	// so onClose runs while picked is still false. Mark picked and resolve up-front to avoid
	// a spurious cancel; onChooseItem stays in place as a redundant safety net.
	selectSuggestion(value: FuzzyMatch<ModelPickerOption>, evt: MouseEvent | KeyboardEvent): void {
		this.picked = true;
		this.onPick({ providerId: value.item.provider.id, modelId: value.item.model.id });
		this.close();
	}

	onChooseItem(item: ModelPickerOption): void {
		this.picked = true;
		this.onPick({ providerId: item.provider.id, modelId: item.model.id });
	}

	onClose(): void {
		super.onClose();
		if (!this.picked && this.onCancel) this.onCancel();
	}
}

export function buildModelPickerOptions(
	providers: Provider[],
	allow?: ProviderModelRef[],
): ModelPickerOption[] {
	const options: ModelPickerOption[] = [];
	const allowSet = allow && allow.length > 0
		? new Set(allow.map(formatModelRef))
		: null;

	for (const provider of providers) {
		for (const model of provider.models ?? []) {
			if (allowSet && !allowSet.has(formatModelRef({ providerId: provider.id, modelId: model.id }))) continue;
			options.push({ provider, model });
		}
	}
	return options;
}
