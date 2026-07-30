import { TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobType, OrchestrationEnqueueOptions } from './types';
import type { TriggerDef } from '../types';
import { triggerDefToOrchestrationTrigger } from '../triggers/triggerAdapter';
import { isPluginManagedPath } from '../triggers/pluginManagedPath';
import { INTERNAL_PLUGIN_FOLDER } from '../exclusions';
import { logWarn } from '../log';

export interface TriggerJobSeed {
	type: JobType;
	params?: Record<string, unknown>;
	options?: OrchestrationEnqueueOptions;
}

export type TriggerEventName = 'create' | 'modify' | 'metadata-changed' | 'rename' | 'youtube-metadata-enriched';

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
		| { event: TriggerEventName }
		| { events: TriggerEventName[] }
		| { everyMs: () => number }; // schedule; <= 0 disables
	/** Hard gate (feature flags etc.). Combined with the per-trigger settings override. */
	enabled: () => boolean;
	/** Event triggers only: must return true for the file to enqueue. */
	guard?: (file: TFile, fm: Record<string, unknown> | undefined, cache?: CachedMetadata) => boolean;
	/** Jobs to enqueue when the trigger fires. `file` is set for event triggers. */
	jobs: (file?: TFile) => TriggerJobSeed[];
}

// Coalesces repeated cache-ready updates during active editing into one evaluation.
// Consistency comes from metadataCache 'changed', not from this timer.
const EVENT_DEBOUNCE_MS = 2000;
// Schedule triggers are checked on a heartbeat so `everyMs` getters track live
// settings without re-registering timers.
const SCHEDULE_TICK_MS = 60_000;

/**
 * Routes note lifecycle events and interval schedules into orchestrator enqueues.
 * Holds two slices: code-defined "founding" triggers (registered in `main.ts onload()`,
 * toggled via `orchestrationTriggersEnabled`) and user-defined triggers rebuilt from
 * `settings.triggers` via {@link setUserTriggers} (which carry their own `enabled` flag).
 */
export class TriggerRegistry {
	private readonly foundingTriggers: OrchestrationTrigger[] = [];
	private userTriggers: OrchestrationTrigger[] = [];
	// Raw note events that must wait for metadataCache 'changed' before conditions
	// can be evaluated against a consistent cache snapshot.
	private readonly pendingConsistentEvents = new Map<string, Set<TriggerEventName>>();
	// Debounce timers per path, separated by event so a 'modify' burst and a
	// 'metadata-changed' burst on the same note don't clobber each other's timer.
	private readonly pendingByEvent = new Map<TriggerEventName, Map<string, number>>();
	private readonly lastScheduledRun = new Map<string, number>();
	private started = false;

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly isMaterializing: () => boolean,
	) {}

	/** Register a code-defined founding trigger. */
	register(trigger: OrchestrationTrigger): void {
		this.foundingTriggers.push(trigger);
	}

	/** Rebuild the user-defined trigger slice from settings. Call on load and after edits. */
	setUserTriggers(defs: TriggerDef[]): void {
		this.userTriggers = defs.map(def => triggerDefToOrchestrationTrigger(def, this.plugin));
		// Anchor any newly-seen schedule triggers so a resave doesn't immediately re-fire
		// them; leave existing anchors intact so editing one trigger doesn't reset others.
		const now = Date.now();
		for (const t of this.userTriggers) {
			if ('everyMs' in t.on && !this.lastScheduledRun.has(t.id)) this.lastScheduledRun.set(t.id, now);
		}
	}

	private allTriggers(): OrchestrationTrigger[] {
		return [...this.foundingTriggers, ...this.userTriggers];
	}

	// Job files under the orchestration queue root, and anything under the plugin's
	// internal folder more broadly (link_registry, source_eval, cli-runs, debug.md,
	// intake staging), are plugin-managed churn — not user note activity — and must
	// never reach a trigger. This is the fix for the trigger-storm incident: a queue
	// job's own create wrote a new job, which wrote a new job, unbounded. Deliberately
	// NOT `_blog_metadata` — that folder is a legitimate trigger target (see the
	// investigation's exclusion-predicate section).
	private isPluginManagedPath(path: string): boolean {
		return isPluginManagedPath(path, [this.plugin.settings.orchestrationQueueRoot, INTERNAL_PLUGIN_FOLDER]);
	}

	/** Registered triggers, for the settings UI. */
	list(): readonly OrchestrationTrigger[] {
		return this.allTriggers();
	}

	/** Code-defined founding triggers only (the ones gated by orchestrationTriggersEnabled). */
	listFounding(): readonly OrchestrationTrigger[] {
		return this.foundingTriggers;
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
			if (file instanceof TFile) this.waitForConsistentCache('create', file);
		}));
		plugin.registerEvent(plugin.app.vault.on('rename', file => {
			if (file instanceof TFile) this.fireEvent('rename', file);
		}));
		plugin.registerEvent(plugin.app.vault.on('modify', file => {
			if (file instanceof TFile) this.waitForConsistentCache('modify', file);
		}));
		plugin.registerEvent(plugin.app.metadataCache.on('changed', (file, _data, cache) => {
			this.onCacheChanged(file, cache);
		}));
		plugin.register(plugin.ingestionEvents.on('metadata-enriched', ({ metadataFile }) => {
			this.waitForConsistentCache('youtube-metadata-enriched', metadataFile, true);
		}));
		// Anchor schedules at startup so a plugin reload doesn't immediately re-fire
		// every interval trigger; the first run lands one interval after load.
		const now = Date.now();
		for (const t of this.allTriggers()) {
			if ('everyMs' in t.on) this.lastScheduledRun.set(t.id, now);
		}
		plugin.registerInterval(window.setInterval(() => this.tickSchedules(), SCHEDULE_TICK_MS));
	}

	dispose(): void {
		for (const timers of this.pendingByEvent.values()) {
			for (const timer of timers.values()) window.clearTimeout(timer);
			timers.clear();
		}
		this.pendingConsistentEvents.clear();
	}

	private waitForConsistentCache(event: TriggerEventName, file: TFile, useCurrentCache = false): void {
		if (file.extension !== 'md') return;
		if (this.isPluginManagedPath(file.path)) return;
		if (useCurrentCache) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			if (cache) {
				this.evaluateCacheReadyEvent(event, file, cache);
				return;
			}
		}
		let pending = this.pendingConsistentEvents.get(file.path);
		if (!pending) {
			pending = new Set<TriggerEventName>();
			this.pendingConsistentEvents.set(file.path, pending);
		}
		pending.add(event);
	}

	private onCacheChanged(file: TFile, cache: CachedMetadata): void {
		if (file.extension !== 'md') return;
		// Essential, not redundant: metadataCache 'changed' reaches fireEvent directly
		// (via evaluateCacheReadyEvent), bypassing waitForConsistentCache entirely.
		if (this.isPluginManagedPath(file.path)) return;
		const events = this.pendingConsistentEvents.get(file.path) ?? new Set<TriggerEventName>();
		this.pendingConsistentEvents.delete(file.path);
		events.add('metadata-changed');
		for (const event of events) this.evaluateCacheReadyEvent(event, file, cache);
	}

	private evaluateCacheReadyEvent(event: TriggerEventName, file: TFile, cache: CachedMetadata): void {
		if (event === 'modify' || event === 'metadata-changed') {
			this.scheduleDebouncedEvaluation(event, file, cache);
			return;
		}
		this.fireEvent(event, file, cache);
	}

	private scheduleDebouncedEvaluation(event: TriggerEventName, file: TFile, cache: CachedMetadata): void {
		if (file.extension !== 'md') return;
		let timers = this.pendingByEvent.get(event);
		if (!timers) {
			timers = new Map<string, number>();
			this.pendingByEvent.set(event, timers);
		}
		const existing = timers.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		const eventTimers = timers;
		eventTimers.set(file.path, window.setTimeout(() => {
			eventTimers.delete(file.path);
			const fresh = this.plugin.app.vault.getAbstractFileByPath(file.path);
			if (fresh instanceof TFile) this.fireEvent(event, fresh, cache);
		}, EVENT_DEBOUNCE_MS));
	}

	private fireEvent(event: TriggerEventName, file: TFile, cache?: CachedMetadata): void {
		if (file.extension !== 'md') return;
		// Backstop: 'rename' reaches here with no cache wait, so it never passes
		// through waitForConsistentCache/onCacheChanged above.
		if (this.isPluginManagedPath(file.path)) return;
		// While a command/chain holds the note's lock it is the sole mutator; its
		// mid-flight writes must not spawn jobs (same gate as the auto edit-triggers).
		if (this.isMaterializing() || this.plugin.noteLocks.isLocked(file.path)) return;
		const fm = cache
			? cache.frontmatter as Record<string, unknown> | undefined
			: this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		for (const trigger of this.allTriggers()) {
			if (!triggerMatchesEvent(trigger, event)) continue;
			if (!this.isEnabled(trigger)) continue;
			try {
				if (trigger.guard && !trigger.guard(file, fm, cache)) continue;
				this.enqueueAll(trigger, file);
			} catch (e) {
				logWarn('trigger', trigger.id, 'failed on', file.path, e);
			}
		}
	}

	private tickSchedules(): void {
		const now = Date.now();
		for (const trigger of this.allTriggers()) {
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
			void this.plugin.orchestrator.enqueue(seed.type, seed.params, { lane: 'background', ...seed.options });
		}
	}
}

function triggerMatchesEvent(trigger: OrchestrationTrigger, event: TriggerEventName): boolean {
	if ('event' in trigger.on) return trigger.on.event === event;
	if ('events' in trigger.on) return trigger.on.events.includes(event);
	return false;
}
