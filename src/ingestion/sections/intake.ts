import type { JobType } from '../../orchestration/types';
import {
	BlogsIntakeRunStat,
	YoutubeIntakeRunStat,
	listYoutubeIntakeRuns,
	listBlogsIntakeRuns,
} from '../../orchestration/utils/feedIntake';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink } from '../render/cells';
import { lastRunLabel } from '../render/format';
import type { DashboardHost, IntakeKind, SectionContext } from '../render/types';

const INTAKE_JOB_TYPE: Record<IntakeKind, JobType> = {
	blog: 'blogs_tracker',
	youtube: 'youtube_tracker',
};

export interface IntakeSection {
	renderBlogIntake(body: HTMLElement, ctx: SectionContext): void;
	renderYoutubeIntake(body: HTMLElement, ctx: SectionContext): void;
	renderEnqueueIntakeButton(heading: HTMLElement, kind: IntakeKind): void;
	refreshIntakeButton(kind: IntakeKind): Promise<void>;
	clear(): void;
}

// Blog + YouTube intake run tables, plus the "Enqueue intake" button trio each
// section header carries (button state is owned here since it's read back by
// both the intake sections and the Queue monitor's debounced refresh).
export function createIntakeSection(host: DashboardHost): IntakeSection {
	const intakeButtons = new Map<IntakeKind, HTMLButtonElement>();
	// Last state rendered per button, so a queue tick that doesn't change the
	// button's state (the common case — most ticks are unrelated job types)
	// skips the DOM rebuild entirely instead of doing btn.empty() + rebuild
	// ~1x/sec during queue churn. A WeakMap needs no explicit clearing on
	// dashboard remount: createIntakeSection builds fresh <button> elements
	// every mount, so a prior mount's entries simply become unreachable.
	const lastButtonState = new WeakMap<HTMLButtonElement, 'idle' | 'queued' | 'running'>();

	function setIntakeButtonState(btn: HTMLButtonElement, state: 'idle' | 'queued' | 'running'): void {
		if (lastButtonState.get(btn) === state) return;
		lastButtonState.set(btn, state);
		btn.empty();
		switch (state) {
			case 'idle':
				btn.setText('Enqueue intake');
				btn.disabled = false;
				btn.removeAttribute('aria-busy');
				break;
			case 'queued':
				btn.setText('Queued');
				btn.disabled = true;
				btn.removeAttribute('aria-busy');
				break;
			case 'running':
				btn.createSpan({ cls: 'crucible-spinner' });
				btn.appendText(' Running…');
				btn.disabled = true;
				btn.setAttribute('aria-busy', 'true');
				break;
		}
	}

	function renderEnqueueIntakeButton(heading: HTMLElement, kind: IntakeKind): void {
		const btn = heading.createEl('button', { cls: 'crucible-ingestion-enqueue-intake' });
		btn.setText('Enqueue intake');
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			void host.plugin.orchestrator.enqueue(INTAKE_JOB_TYPE[kind], {}, { priority: 'high', lane: 'user' });
		});
		intakeButtons.set(kind, btn);
	}

	async function refreshIntakeButton(kind: IntakeKind): Promise<void> {
		const btn = intakeButtons.get(kind);
		if (!btn) return;
		const jobType = INTAKE_JOB_TYPE[kind];
		const orchestrator = host.plugin.orchestrator;
		if (!orchestrator) return;
		let state: 'idle' | 'queued' | 'running' = 'idle';
		try {
			// One seam call per state to check (WP-7): backend-agnostic count(statuses),
			// replacing the two full listFolder passes this used to run inline. Running
			// takes priority in the displayed state, same as before.
			if (await orchestrator.countJobs(jobType, ['running']) > 0) {
				state = 'running';
			} else if (await orchestrator.countJobs(jobType, ['queued']) > 0) {
				state = 'queued';
			}
		} catch {
			state = 'idle';
		}
		setIntakeButtonState(btn, state);
	}

	// --- Section: Blog Intake ---
	function renderBlogIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listBlogsIntakeRuns(host.app);
		host.setSectionMeta('blogIntake', lastRunLabel(rows.map(r => r.runAt)));
		// P5: skip the rebuild on an unchanged row set during an event-driven pass.
		if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
		renderTableSection<BlogsIntakeRunStat>({
			body, ctx, rows,
			emptyText: 'No blog tracker runs yet.',
			defaultSort: { column: 'runAt', direction: 'desc' },
			// rsp-wp6: one row per intake-run note — the vault path is the natural key.
			rowKey: r => r.file.path,
			setCount: n => host.setSectionCount('blogIntake', n),
			columns: [
				{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => renderFileLink(host.app, td, r.file, r.runAt || r.file.basename) },
				{ key: 'blogsTotal', label: 'Blogs', sortable: true, sortKey: r => r.blogsTotal, render: (r, td) => td.setText(String(r.blogsTotal)) },
				{ key: 'blogsWithNew', label: 'With New', sortable: true, sortKey: r => r.blogsWithNew, render: (r, td) => td.setText(String(r.blogsWithNew)) },
				{ key: 'postsTotal', label: 'Posts', sortable: true, sortKey: r => r.postsTotal, render: (r, td) => td.setText(String(r.postsTotal)) },
				{ key: 'blogsFailed', label: 'Failed', sortable: true, sortKey: r => r.blogsFailed, render: (r, td) => td.setText(String(r.blogsFailed)) },
				{ key: 'rowsSkipped', label: 'Skipped', sortable: true, sortKey: r => r.rowsSkipped, render: (r, td) => td.setText(String(r.rowsSkipped)) },
				{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
			],
		});
	}

	// --- Section: YouTube Intake ---
	function renderYoutubeIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listYoutubeIntakeRuns(host.app);
		host.setSectionMeta('youtubeIntake', lastRunLabel(rows.map(r => r.runAt)));
		// P5: skip the rebuild on an unchanged row set during an event-driven pass.
		if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
		renderTableSection<YoutubeIntakeRunStat>({
			body, ctx, rows,
			emptyText: 'No YouTube tracker runs yet.',
			defaultSort: { column: 'runAt', direction: 'desc' },
			// rsp-wp6: one row per intake-run note — the vault path is the natural key.
			rowKey: r => r.file.path,
			setCount: n => host.setSectionCount('youtubeIntake', n),
			columns: [
				{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => renderFileLink(host.app, td, r.file, r.runAt || r.file.basename) },
				{ key: 'channelsTotal', label: 'Channels', sortable: true, sortKey: r => r.channelsTotal, render: (r, td) => td.setText(String(r.channelsTotal)) },
				{ key: 'channelsWithNew', label: 'With New', sortable: true, sortKey: r => r.channelsWithNew, render: (r, td) => td.setText(String(r.channelsWithNew)) },
				{ key: 'videosTotal', label: 'Videos', sortable: true, sortKey: r => r.videosTotal, render: (r, td) => td.setText(String(r.videosTotal)) },
				{ key: 'channelsFailed', label: 'Failed', sortable: true, sortKey: r => r.channelsFailed, render: (r, td) => td.setText(String(r.channelsFailed)) },
				{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
			],
		});
	}

	return {
		renderBlogIntake,
		renderYoutubeIntake,
		renderEnqueueIntakeButton,
		refreshIntakeButton,
		clear: () => intakeButtons.clear(),
	};
}
