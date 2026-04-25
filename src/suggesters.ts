import { TAbstractFile, TFile, TFolder, AbstractInputSuggest, App, prepareFuzzySearch, renderResults } from "obsidian";

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
            // Sort by length/depth even for empty input
            return items
                .sort((a, b) => (a.path.length - b.path.length) || (a.path.split('/').length - b.path.split('/').length))
                .slice(0, 100);
        }

        const fuzzySearch = prepareFuzzySearch(inputStr);
        const results = items
            .map(item => ({ item, result: fuzzySearch(item.path) }))
            .filter(res => res.result !== null)
            .sort((a, b) => {
                // Primary: Fuzzy score (lower is usually better in Obsidian's prepareFuzzySearch)
                if (a.result!.score !== b.result!.score) {
                    return a.result!.score - b.result!.score;
                }
                
                // Secondary: Path length (shorter is better)
                if (a.item.path.length !== b.item.path.length) {
                    return a.item.path.length - b.item.path.length;
                }
                
                // Tertiary: Path depth (fewer segments is better)
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
        return this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder);
    }
}

export class FileSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        return this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFile && f.extension === 'md');
    }
}
