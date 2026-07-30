import { TFile } from 'obsidian';
import { logWarn } from './log';

export type AutoLocalizeSource = 'create' | 'edit';

export interface AutoLocalizeState {
	path: string;
	sources: Set<AutoLocalizeSource>;
	firstScheduledAt: number;
	attempts: number;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface AutoLocalizeSchedulerDeps {
	resolveFile(path: string): TFile | null;
	isLocked(path: string): boolean;
	isMaterializing(): boolean;
	sourceEnabled(source: AutoLocalizeSource): boolean;
	localize(file: TFile): Promise<unknown>;
}

const AUTO_LOCALIZE_CREATE_DELAY_MS = 2500;
const AUTO_LOCALIZE_EDIT_DELAY_MS = 3000;
const AUTO_LOCALIZE_RETRY_DELAY_MS = 1000;
const AUTO_LOCALIZE_MAX_AGE_MS = 15000;

export class AutoLocalizeScheduler {
	private readonly timers = new Map<string, AutoLocalizeState>();

	constructor(private readonly deps: AutoLocalizeSchedulerDeps) {}

	schedule(
		file: TFile,
		source: AutoLocalizeSource,
		delayMs: number = source === 'create' ? AUTO_LOCALIZE_CREATE_DELAY_MS : AUTO_LOCALIZE_EDIT_DELAY_MS,
	): void {
		if (file.extension !== 'md') return;
		if (!this.deps.sourceEnabled(source)) return;

		const existing = this.timers.get(file.path);
		const state: AutoLocalizeState = existing ?? {
			path: file.path,
			sources: new Set<AutoLocalizeSource>(),
			firstScheduledAt: Date.now(),
			attempts: 0,
			timer: null,
		};
		state.path = file.path;
		state.sources.add(source);
		this.scheduleState(state, delayMs);
	}

	move(oldPath: string, newPath: string): void {
		const state = this.timers.get(oldPath);
		if (!state) return;
		this.timers.delete(oldPath);
		state.path = newPath;
		this.scheduleState(state, AUTO_LOCALIZE_RETRY_DELAY_MS);
	}

	cancel(path: string): void {
		const pending = this.timers.get(path);
		if (pending?.timer) clearTimeout(pending.timer);
		this.timers.delete(path);
	}

	clear(): void {
		for (const state of this.timers.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.timers.clear();
	}

	get(path: string): AutoLocalizeState | undefined {
		return this.timers.get(path);
	}

	async run(state: AutoLocalizeState): Promise<void> {
		this.timers.delete(state.path);
		if (!this.sourcesEnabled(state)) return;

		const current = this.deps.resolveFile(state.path);
		if (!(current instanceof TFile) || current.extension !== 'md') return;

		if (current.stat.size === 0 || this.deps.isLocked(current.path) || this.deps.isMaterializing()) {
			if (Date.now() - state.firstScheduledAt <= AUTO_LOCALIZE_MAX_AGE_MS) {
				state.path = current.path;
				state.attempts += 1;
				this.scheduleState(state, AUTO_LOCALIZE_RETRY_DELAY_MS);
			}
			return;
		}

		await this.deps.localize(current);
	}

	private scheduleState(state: AutoLocalizeState, delayMs: number): void {
		if (state.timer) clearTimeout(state.timer);
		this.timers.set(state.path, state);
		state.timer = setTimeout(() => {
			state.timer = null;
			this.run(state).catch((e) => logWarn('auto-localize run failed', state.path, e));
		}, delayMs);
	}

	private sourcesEnabled(state: AutoLocalizeState): boolean {
		return Array.from(state.sources).some(source => this.deps.sourceEnabled(source));
	}
}
