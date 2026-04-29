import { TAbstractFile, TFile, TFolder, AbstractInputSuggest, App, prepareFuzzySearch, renderResults, Command } from "obsidian";

export abstract class FileSystemSuggest extends AbstractInputSuggest<TAbstractFile> {
    public inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }

    abstract getItems(): TAbstractFile[];

    getSuggestions(inputStr: string): TAbstractFile[] {
        const items = this.getItems();
        
        if (!inputStr) {
            return items
                .sort((a, b) => (a.path.length - b.path.length) || (a.path.split('/').length - b.path.split('/').length))
                .slice(0, 100);
        }

        const fuzzySearch = prepareFuzzySearch(inputStr);
        const results = items
            .map(item => ({ item, result: fuzzySearch(item.path) }))
            .filter(res => res.result !== null)
            .sort((a, b) => {
                if (a.result!.score !== b.result!.score) {
                    return a.result!.score - b.result!.score;
                }
                if (a.item.path.length !== b.item.path.length) {
                    return a.item.path.length - b.item.path.length;
                }
                const aDepth = a.item.path.split('/').length;
                const bDepth = b.item.path.split('/').length;
                return aDepth - bDepth;
            })
            .map(res => res.item);

        return results.slice(0, 100);
    }

    renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
        const inputStr = this.inputEl ? this.inputEl.value : "";
        
        if (inputStr) {
            const fuzzySearch = prepareFuzzySearch(inputStr);
            const result = fuzzySearch(file.path);
            if (result) {
                renderResults(el, file.path, result);
                return;
            }
        }
        
        el.setText(file.path);
    }

    selectSuggestion(file: TAbstractFile): void {
        this.inputEl.value = file.path;
        this.inputEl.dispatchEvent(new Event("input"));
        this.close();
    }
}

export class FolderSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        const files = this.app.vault.getAllLoadedFiles();
        return files.filter(f => {
            if (!(f instanceof TFolder)) return false;
            return !this.app.metadataCache.isUserIgnored(f.path);
        });
    }
}

export class FileSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        const files = this.app.vault.getAllLoadedFiles();
        return files.filter(f => {
            if (!(f instanceof TFile) || f.extension !== 'md') return false;
            return !this.app.metadataCache.isUserIgnored(f.path);
        });
    }
}

export class CommandSuggest extends AbstractInputSuggest<Command> {
	public inputEl: HTMLInputElement;
	private extraCommands: Command[];
	private onChoose?: (command: Command) => void;

	constructor(app: App, inputEl: HTMLInputElement, extraCommands: Command[] = [], onChoose?: (command: Command) => void) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.extraCommands = extraCommands;
		this.onChoose = onChoose;
	}

	getItems(): Command[] {
		return getCommandSuggestItems(this.app, this.extraCommands);
	}

	getSuggestions(inputStr: string): Command[] {
		const items = this.getItems();
		if (!inputStr) return items.slice(0, 100);

		const fuzzySearch = prepareFuzzySearch(inputStr);
		return items
			.map(item => ({ item, result: fuzzySearch(item.name) }))
			.filter(res => res.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.map(res => res.item)
			.slice(0, 100);
	}

	renderSuggestion(command: Command, el: HTMLElement): void {
		el.setText(command.name);
	}

	selectSuggestion(command: Command): void {
		if (this.onChoose) {
			this.inputEl.value = command.name;
			this.onChoose(command);
		} else {
			this.inputEl.value = command.id;
			this.inputEl.dispatchEvent(new Event("input"));
		}
		this.close();
	}
}

export function getCommandSuggestItems(app: App, extraCommands: Command[] = []): Command[] {
	const commands = app.commands.listCommands();

	// Add internal virtual commands for easier selection in Chains.
	const internal: Command[] = [
		{ id: 'crucible:capture', name: 'Crucible: Quick Capture (Name|Value)' },
		{ id: 'crucible:upsert-property', name: 'Crucible: Add/update file property' },
		{ id: 'crucible:upsert-tags', name: 'Crucible: Upsert frontmatter tags' },
		...extraCommands
	];

	return [...internal, ...commands];
}

export function findCommandSuggestItem(app: App, value: string, extraCommands: Command[] = []): Command | undefined {
	const normalizedValue = value.trim();
	return getCommandSuggestItems(app, extraCommands)
		.find(command => command.id === normalizedValue || command.name === normalizedValue);
}

export function getCommandSuggestDisplayName(app: App, commandId: string, extraCommands: Command[] = []): string {
	return getCommandSuggestItems(app, extraCommands)
		.find(command => command.id === commandId)?.name || commandId;
}
