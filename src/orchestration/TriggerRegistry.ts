import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobType } from './types';
import { logWarn } from '../log';

export interface TriggerJobSeed {
	type: JobType;
	params?: Record<string, unknown>;
}

/**
 * A declarative auto-enqueue rule: a note lifecycle event or a schedule, an
 * enabled gate, an optional guard, and the job(s) to enqueue. Triggers never run
 * work themselves — they only feed the unified queue, so every triggered task
 * inherits queue semantics (dedupe, per-type pacing, timeout, note locks).
 */
export interface OrchestrationTrigger {
	/** Stable id: keys the per-trigger settings override and log lines. */
	id: string;
	/** Shown next to the settings toggle. */
	description: string;
	on:
		| { event: 'create' | 'metadata-changed' | 'rename' }
		| { everyMs: () => number }; // schedule; <= 0 disables
	/** Hard gate (feature flags etc.). Combined with the per-trigger settings override. */
	enabled: () => boolean;
	/** Event triggers only: must return true for the file to enqueue. */
	guard?: (file: TFile, fm: Record<string, unknown> | undefined) => boolean;
	/** Jobs to enqueue when the trigger fires. `file` is set for event triggers. */
	jobs: (file?: TFile) => TriggerJobSeed[];
}

// Coalesces the per-keystroke metadataCache 'changed' burst into one evaluation.
const METADATA_DEBOUNCE_MS = 2000;
// Schedule triggers are checked on a heartbeat so `everyMs` getters track live
// settings without re-registering timers.
const SCHEDULE_TICK_MS = 60_000;

/**
 * Routes note lifecycle events and interval schedules into orchestrator enqueues.
 * Code-defined registry: triggers are registered in `main.ts onload()`; settings
 * only expose per-trigger enable toggles (`orchestrationTriggersEnabled`).
 */
export class TriggerRegistry {
	private readonly triggers: OrchestrationTrigger[] = [];
	private readonly pendingPaths = new Map<string, number>();
	private readonly lastScheduledRun = new Map<string, number>();
	private started = false;

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly isMaterializing: () => boolean,
	) {}

	register(trigger: OrchestrationTrigger): void {
		this.triggers.push(trigger);
	}

	/** Registered triggers, for the settings UI. */
	list(): readonly OrchestrationTrigger[] {
		return this.triggers;
	}

	/** Effective on/off including the per-trigger settings override. */
	isEnabled(trigger: OrchestrationTrigger): boolean {
		const override = this.plugin.settings.orchestrationTriggersEnabled[trigger.id];
		return (override ?? true) && trigger.enabled();
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		const { plugin } = this;
		plugin.registerEvent(plugin.app.vault.on('create', file => {
			if (file instanceof TFile) this.fireEvent('create', file);
		}));
		plugin.registerEvent(plugin.app.vault.on('rename', file => {
			if (file instanceof TFile) this.fireEvent('rename', file);
		}));
		plugin.registerEvent(plugin.app.metadataCache.on('changed', file => {
			this.scheduleMetadataEvaluation(file);
		}));
		// Anchor schedules at startup so a plugin reload doesn't immediately re-fire
		// every interval trigger; the first run lands one interval after load.
		const now = Date.now();
		for (const t of this.triggers) {
			if ('everyMs' in t.on) this.lastScheduledRun.set(t.id, now);
		}
		plugin.registerInterval(window.setInterval(() => this.tickSchedules(), SCHEDULE_TICK_MS));
	}

	dispose(): void {
		for (const timer of this.pendingPaths.values()) window.clearTimeout(timer);
		this.pendingPaths.clear();
	}

	private scheduleMetadataEvaluation(file: TFile): void {
		if (file.extension !== 'md') return;
		const existing = this.pendingPaths.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.pendingPaths.set(file.path, window.setTimeout(() => {
			this.pendingPaths.delete(file.path);
			const fresh = this.plugin.app.vault.getAbstractFileByPath(file.path);
			if (fresh instanceof TFile) this.fireEvent('metadata-changed', fresh);
		}, METADATA_DEBOUNCE_MS));
	}

	private fireEvent(event: 'create' | 'metadata-changed' | 'rename', file: TFile): void {
		if (file.extension !== 'md') return;
		// While a command/chain holds the note's lock it is the sole mutator; its
		// mid-flight writes must not spawn jobs (same gate as the auto edit-triggers).
		if (this.isMaterializing() || this.plugin.noteLocks.isLocked(file.path)) return;
		const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		for (const trigger of this.triggers) {
			if (!('event' in trigger.on) || trigger.on.event !== event) continue;
			if (!this.isEnabled(trigger)) continue;
			try {
				if (trigger.guard && !trigger.guard(file, fm)) continue;
				this.enqueueAll(trigger, file);
			} catch (e) {
				logWarn('trigger', trigger.id, 'failed on', file.path, e);
			}
		}
	}

	private tickSchedules(): void {
		const now = Date.now();
		for (const trigger of this.triggers) {
			if (!('everyMs' in trigger.on)) continue;
			const interval = trigger.on.everyMs();
			if (interval <= 0 || !this.isEnabled(trigger)) continue;
			const last = this.lastScheduledRun.get(trigger.id) ?? 0;
			if (now - last < interval) continue;
			this.lastScheduledRun.set(trigger.id, now);
			try {
				this.enqueueAll(trigger);
			} catch (e) {
				logWarn('trigger', trigger.id, 'schedule failed', e);
			}
		}
	}

	private enqueueAll(trigger: OrchestrationTrigger, file?: TFile): void {
		for (const seed of trigger.jobs(file)) {
			// Dedupe keys absorb repeat fires; a null return just means "already queued".
			void this.plugin.orchestrator.enqueue(seed.type, seed.params);
		}
	}
}
