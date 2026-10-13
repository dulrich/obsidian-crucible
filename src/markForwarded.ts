import { App, Editor, MarkdownView, TFile } from 'obsidian';

const OPEN_CHECKBOX_REGEX = /^(\s*[-*+]\s+\[) (\]\s+.*)$/;

/**
 * mark-as-forwarded: turn the cursor line's open checkbox into `[>]` and persist it to disk
 * before returning, so a chain's post-run editor reconcile (which reloads the buffer from
 * disk) cannot revert it. Returns false when the line isn't an open checkbox.
 */
export async function markEditorLineForwarded(app: App, editor: Editor, file?: TFile | null): Promise<boolean> {
	const cursor = editor.getCursor();
	const lineNum = cursor.line;
	const line = editor.getLine(lineNum);
	if (!OPEN_CHECKBOX_REGEX.test(line)) return false;
	const newLine = line.replace(OPEN_CHECKBOX_REGEX, '$1>$2');
	editor.setLine(lineNum, newLine);
	editor.setCursor(cursor);

	let view: MarkdownView | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (!view && leaf.view instanceof MarkdownView && leaf.view.editor === editor) view = leaf.view;
	});
	const found = view as MarkdownView | null;
	if (found) {
		await found.save();
		return true;
	}
	if (file) {
		await app.vault.process(file, (data) => {
			const lines = data.split('\n');
			if (lines[lineNum] === line) lines[lineNum] = newLine;
			return lines.join('\n');
		});
	}
	return true;
}
