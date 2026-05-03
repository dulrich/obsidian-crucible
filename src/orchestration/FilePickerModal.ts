import { App, FuzzySuggestModal, TFile } from 'obsidian';

export class FilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private title: string,
		private onPick: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(title);
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}
