import { Notice, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { CrucibleSettings } from '../types';

/** How long the notice stays up. Long, deliberately: it names a folder the user has to
 * go and find, and it is shown exactly once in the lifetime of the vault. */
const ARCHIVE_NOTICE_MS = 15000;

/**
 * The one-time "the old queue folder is a frozen archive" notice (thq WP-8).
 *
 * The cutover deliberately does NOT import the ~20k markdown job files
 * (`plans/trigger-hardening-and-sqlite-queue.md`, Decisions): jobs live in the plugin's
 * own database now and the plugin never reads that folder again. Which leaves a folder
 * full of notes nothing will ever touch, inflating the vault's note count exactly as
 * before — so the user has to be *told*, once, that deleting it is safe.
 *
 * Three properties worth stating, because each is a decision rather than an
 * implementation detail:
 *
 *  * **Never auto-deleted.** Those are thousands of the user's own vault files. A
 *    plugin upgrade silently trashing them is not a trade this plugin gets to make on
 *    their behalf, however confident it is that nothing reads them.
 *  * **A Notice, not a modal.** This is information, not a decision to block startup on.
 *  * **Persisted, so it appears once.** `orchestrationArchiveNoticeShown` is written
 *    only after the notice is actually shown — a user whose folder is already gone
 *    never sees it and never has the flag set, which costs nothing and keeps the flag
 *    meaning what it says.
 */
export function shouldShowArchiveNotice(settings: Pick<CrucibleSettings, 'orchestrationQueueRoot' | 'orchestrationArchiveNoticeShown'>, folderExists: boolean): boolean {
	if (settings.orchestrationArchiveNoticeShown) return false;
	if (!settings.orchestrationQueueRoot) return false;
	return folderExists;
}

export function archiveNoticeText(queueRoot: string): string {
	return `Crucible: jobs now live in the plugin database, not in "${queueRoot}". That folder is a frozen archive — `
		+ 'nothing reads or writes it any more, and you can delete it on disk whenever you like.';
}

/**
 * Shows the notice if it is due, and records that it was. `save` is the caller's
 * settings persist — passed in rather than reached for so this stays drivable without a
 * plugin instance.
 */
export async function maybeShowArchiveNotice(
	app: App,
	settings: Pick<CrucibleSettings, 'orchestrationQueueRoot' | 'orchestrationArchiveNoticeShown'>,
	save: () => Promise<void>,
): Promise<boolean> {
	const root = settings.orchestrationQueueRoot;
	const folderExists = !!root && app.vault.getAbstractFileByPath(root) instanceof TFolder;
	if (!shouldShowArchiveNotice(settings, folderExists)) return false;
	new Notice(archiveNoticeText(root), ARCHIVE_NOTICE_MS);
	settings.orchestrationArchiveNoticeShown = true;
	await save();
	return true;
}
