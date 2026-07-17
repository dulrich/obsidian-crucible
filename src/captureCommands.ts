import { Editor, Notice, TFile } from 'obsidian';
import type CruciblePlugin from './main';
import { Capture } from './types';
import { CaptureExecutionContext, TextInputModal } from './captures';

export function registerCaptures(plugin: CruciblePlugin): void {
	const prefix = plugin.manifest.id;
	plugin.clearCommandRegistryGroup('Captures');
	plugin.settings.captures.forEach((capture, index) => {
		if (!capture.name) return;
		const id = `capture-${index}`;
		const fullId = `${prefix}:${id}`;

		// Register in ChainManager so it can handle args/responses
		plugin.chainManager.registerInternalCommand(fullId, async (args, _prev, editor, targetFile) => {
			const resolvedValue = args._default || await resolveCaptureValue(plugin, capture, editor);
			if (resolvedValue === null) return false;
			return await plugin.captureManager.executeCapture(
				capture,
				resolvedValue,
				targetFile,
				resolveCaptureContext(plugin, editor, capture, targetFile),
			);
		});

		plugin.registerCrucibleCommand({
			id,
			name: `Capture: ${capture.name}`,
			group: 'Captures',
			run: async () => {
				const editor = plugin.activeEditor();
				const value = await resolveCaptureValue(plugin, capture, editor);
				if (value === null) return;

				await plugin.captureManager.executeCapture(
					capture,
					value,
					undefined,
					resolveCaptureContext(plugin, editor, capture),
				);
			},
		});
	});
}

export async function resolveCaptureValue(plugin: CruciblePlugin, capture: Capture, editor?: Editor): Promise<string | null> {
	const source = capture.source || 'dialog';

	switch (source) {
		case 'line':
			if (editor) return editor.getLine(editor.getCursor().line);
			new Notice('This capture reads the current line — switch to edit mode.');
			return null;
		case 'line-fallback':
			if (editor) {
				const line = editor.getLine(editor.getCursor().line);
				if (line.trim()) return line;
			}
			return await promptForCaptureValue(plugin, capture);
		case 'selection': {
			if (editor) {
				const selection = editor.getSelection();
				if (selection.trim()) return selection;
			}
			const dom = window.getSelection()?.toString() ?? '';
			if (dom.trim()) return dom;
			new Notice('No text selected. Select text in the note first.');
			return null;
		}
		case 'selection-fallback': {
			if (editor) {
				const selection = editor.getSelection();
				if (selection.trim()) return selection;
			}
			const dom = window.getSelection()?.toString() ?? '';
			if (dom.trim()) return dom;
			return await promptForCaptureValue(plugin, capture);
		}
		case 'dialog':
		default:
			return await promptForCaptureValue(plugin, capture);
	}
}

export function resolveCaptureContext(plugin: CruciblePlugin, editor: Editor | undefined, capture: Capture, sourceFile?: TFile): CaptureExecutionContext {
	if ((capture.targetSectionMode ?? 'fixed') === 'source' && !editor) {
		new Notice('This capture targets the source section but no editor is active. Switch to edit mode.');
		throw new Error('Source-section capture requires an active editor');
	}
	return {
		sourceSectionHeader: editor ? findCurrentSectionHeader(editor) : null,
		sourceFile: sourceFile ?? plugin.app.workspace.getActiveFile(),
	};
}

export async function promptForText(plugin: CruciblePlugin, title: string): Promise<string | null> {
	return new Promise((resolve) => {
		let submitted = false;
		new TextInputModal(
			plugin.app,
			title,
			(value) => {
				submitted = true;
				resolve(value);
			},
			() => {
				if (!submitted) resolve(null);
			},
		).open();
	});
}

async function promptForCaptureValue(plugin: CruciblePlugin, capture: Capture): Promise<string | null> {
	return new Promise((resolve) => {
		new TextInputModal(
			plugin.app,
			`Capture: ${capture.name}`,
			(value) => {
				resolve(value);
			},
			() => {
				plugin.refreshToC();
				resolve(null);
			}
		).open();
	});
}

// Unused by any current caller (dead code prior to this extraction as well);
// exported (rather than dropped) for zero-behavior-change parity with main.ts.
export function openCaptureDialog(plugin: CruciblePlugin, capture: Capture) {
	void (async () => {
		const value = await promptForCaptureValue(plugin, capture);
		if (value !== null) {
			await plugin.captureManager.executeCapture(capture, value);
		}
	})();
}

function findCurrentSectionHeader(editor: Editor): string | null {
	for (let lineNum = editor.getCursor().line; lineNum >= 0; lineNum--) {
		const line = editor.getLine(lineNum).trim();
		if (/^#{1,6}\s+\S/.test(line)) return line;
	}
	return null;
}
