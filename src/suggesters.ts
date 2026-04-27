import { TAbstractFile, TFile, TFolder, AbstractInputSuggest, App, prepareFuzzySearch, renderResults, Command } from "obsidian";

interface MetadataCacheWithIgnore {
    isUserIgnored(path: string): boolean;
}

interface AppWithCommands extends App {
	commands: {
		listCommands(): Command[];
	};
}

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
        const metadataCache = this.app.metadataCache as unknown as MetadataCacheWithIgnore;
        return files.filter(f => {
            if (!(f instanceof TFolder)) return false;
            return !metadataCache.isUserIgnored(f.path);
        });
    }
}

export class FileSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        const files = this.app.vault.getAllLoadedFiles();
        const metadataCache = this.app.metadataCache as unknown as MetadataCacheWithIgnore;
        return files.filter(f => {
            if (!(f instanceof TFile) || f.extension !== 'md') return false;
            return !metadataCache.isUserIgnored(f.path);
        });
    }
}

export class CommandSuggest extends AbstractInputSuggest<Command> {
	public inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getItems(): Command[] {
		const commands = (this.app as AppWithCommands).commands.listCommands();
		
		// Add internal virtual commands for easier selection in Chains
		const internal: Command[] = [
			{ id: 'crucible:lint-note', name: 'Crucible: Lint note' },
			{ id: 'crucible:capture', name: 'Crucible: Quick Capture (Name|Value)' },
			{ id: 'crucible:materialize-day-today', name: 'Crucible: Materialize today' },
			{ id: 'crucible:forward-task', name: 'Crucible: Forward task' },
		];

		return [...internal, ...commands];
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
		this.inputEl.value = command.id;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}