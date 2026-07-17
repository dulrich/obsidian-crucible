import { Editor, Notice, TFile, normalizePath } from 'obsidian';
import type CruciblePlugin from './main';
import { CommandArgSchema } from './types';
import { chainStepResult } from './chains';
import { ensureFolder } from './utils';
import { MoveFileFolderPickerModal, normalizeFolderPath } from './folderPicker';
import { getCurrentPeriodAssetFolder, periodDisabledMessage } from './periods';

export function registerMoveFileCommands(plugin: CruciblePlugin, prefix: string): void {
	const moveDailyId = 'move-current-file-to-daily-folder';
	const moveFolderId = 'move-current-file-to-folder';

	const wrapMoveResult = (moved: TFile | null) => moved ? chainStepResult(true, moved) : false;
	const moveDaily = async (_args: Record<string, string>, _prev: unknown, _editor?: Editor, targetFile?: TFile) => {
		if (!plugin.settings.dailyEnabled) {
			new Notice(periodDisabledMessage('daily'));
			return false;
		}
		return wrapMoveResult(await moveFileToFolder(plugin, getCurrentPeriodAssetFolder(plugin.settings, 'daily'), targetFile));
	};
	const moveFolder = async (args: Record<string, string>, _prev: unknown, _editor?: Editor, targetFile?: TFile) => {
		const folder = args.folder?.trim();
		const moved = folder
			? await moveFileToFolder(plugin, folder, targetFile)
			: await openMoveFileFolderPicker(plugin, targetFile);
		return wrapMoveResult(moved);
	};
	const moveFolderSchema: CommandArgSchema[] = [
		{
			id: 'folder',
			name: 'Destination folder',
			type: 'folder',
			description: 'Folder to move the current file into. Leave empty to show the folder picker.',
		},
	];

	for (const id of [`${prefix}:${moveDailyId}`, `crucible:${moveDailyId}`]) {
		plugin.chainManager.registerInternalCommand(id, moveDaily);
	}
	for (const id of [`${prefix}:${moveFolderId}`, `crucible:${moveFolderId}`]) {
		plugin.chainManager.registerInternalCommand(id, moveFolder, { schema: moveFolderSchema });
	}

	plugin.registerCrucibleCommand({
		id: moveDailyId,
		name: 'Move current file to daily folder',
		group: 'Files',
		available: () => plugin.app.workspace.getActiveFile() !== null,
		run: () => {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (!activeFile) return;
			if (!plugin.settings.dailyEnabled) {
				new Notice(periodDisabledMessage('daily'));
				return;
			}
			return moveFileToFolder(plugin, getCurrentPeriodAssetFolder(plugin.settings, 'daily'), activeFile);
		},
	});

	plugin.registerCrucibleCommand({
		id: moveFolderId,
		name: 'Move current file to folder...',
		group: 'Files',
		available: () => plugin.app.workspace.getActiveFile() !== null,
		run: () => {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (activeFile) return openMoveFileFolderPicker(plugin, activeFile);
			return null;
		},
	});
}

async function openMoveFileFolderPicker(plugin: CruciblePlugin, targetFile?: TFile): Promise<TFile | null> {
	const file = targetFile ?? plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice('No active file to move.');
		return null;
	}

	return await new Promise<TFile | null>((resolve) => {
		new MoveFileFolderPickerModal(
			plugin.app,
			plugin.settings,
			async (folderPath) => {
				resolve(await moveFileToFolder(plugin, folderPath, file));
			},
			() => resolve(null),
		).open();
	});
}

async function moveFileToFolder(plugin: CruciblePlugin, folderPath: string, targetFile?: TFile): Promise<TFile | null> {
	try {
		const file = targetFile ?? plugin.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file to move.');
			return null;
		}

		return await plugin.noteLocks.withLock(file.path, 'move-file', async () => {
			const normalizedFolder = normalizeFolderPath(folderPath);
			if (!normalizedFolder) {
				new Notice('Move target folder is not configured.');
				return null;
			}

			await ensureFolder(plugin.app, normalizedFolder);
			const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);
			if (targetPath === file.path) {
				new Notice(`Already in ${normalizedFolder}`);
				return file;
			}

			const existing = plugin.app.vault.getAbstractFileByPath(targetPath);
			if (existing) {
				new Notice(`Move target already exists: ${targetPath}`);
				return null;
			}

			const oldPath = file.path;
			await plugin.app.fileManager.renameFile(file, targetPath);
			plugin.noteLocks.handleRename(oldPath, targetPath);
			new Notice(`Moved to ${normalizedFolder}`);
			const moved = plugin.app.vault.getAbstractFileByPath(targetPath);
			return moved instanceof TFile ? moved : file;
		});
	} catch (e) {
		new Notice(`Error moving file: ${(e as Error).message}`);
		return null;
	}
}
