import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import { enrichYoutubeMetadataStandalone, ingestYoutubeVideoMetadata, loadYoutubeApiKey } from './utils/youtubeApi';
import { MinIntervalGate } from './utils/rateLimit';

export type EnrichmentItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface EnrichmentQueueItem {
	videoId: string;
	title: string;
	channelName: string;
	sourceFile?: TFile;
}

export interface EnrichmentQueueEntry extends EnrichmentQueueItem {
	status: EnrichmentItemStatus;
	error?: string;
	addedAt: number;
}

export type AutoSourceFn = () => EnrichmentQueueItem[];

interface EnrichmentInternalEntry extends EnrichmentQueueEntry {
	finishedAt?: number;
}

const TERMINAL_RETENTION_MS = 60_000;

export class EnrichmentQueueService {
	private readonly entries = new Map<string, EnrichmentInternalEntry>();
	private autoSource: AutoSourceFn | null = null;
	private autoEnabled = false;
	private readonly rateGate: MinIntervalGate;
	private draining = false;
	private disposed = false;

	constructor(private readonly plugin: CruciblePlugin) {
		this.autoEnabled = plugin.settings.ingestionYoutubeAutoEnrichEnabled === true;
		this.rateGate = new MinIntervalGate(Math.max(0, plugin.settings.ingestionYoutubeEnrichRateLimitSeconds) * 1000);
	}

	dispose(): void {
		this.disposed = true;
		this.entries.clear();
		this.autoSource = null;
	}

	setRateLimitSeconds(seconds: number): void {
		this.rateGate.setIntervalMs(Math.max(0, seconds) * 1000);
	}

	setAutoSource(fn: AutoSourceFn | null): void {
		this.autoSource = fn;
		this.maybeRefillFromAutoSource();
		this.kickDrain();
	}

	setAutoEnabled(enabled: boolean): void {
		this.autoEnabled = enabled;
		this.maybeRefillFromAutoSource();
		this.kickDrain();
	}

	isAutoEnabled(): boolean {
		return this.autoEnabled;
	}

	enqueue(item: EnrichmentQueueItem): boolean {
		if (!item.videoId) return false;
		const existing = this.entries.get(item.videoId);
		if (existing && (existing.status === 'pending' || existing.status === 'running')) {
			return false;
		}
		this.entries.set(item.videoId, {
			...item,
			status: 'pending',
			addedAt: Date.now(),
		});
		this.emitUpdate();
		this.kickDrain();
		return true;
	}

	dequeueIfPending(videoId: string): boolean {
		const entry = this.entries.get(videoId);
		if (!entry || entry.status !== 'pending') return false;
		this.entries.delete(videoId);
		this.emitUpdate();
		return true;
	}

	getEntry(videoId: string): EnrichmentQueueEntry | null {
		const e = this.entries.get(videoId);
		return e ? { ...e } : null;
	}

	getSnapshot(): EnrichmentQueueEntry[] {
		return Array.from(this.entries.values())
			.map(e => ({ ...e }))
			.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.addedAt - b.addedAt);
	}

	getPendingCount(): number {
		let n = 0;
		for (const e of this.entries.values()) {
			if (e.status === 'pending' || e.status === 'running') n++;
		}
		return n;
	}

	private maybeRefillFromAutoSource(): void {
		if (!this.autoEnabled || !this.autoSource) return;
		const candidates = this.autoSource();
		for (const item of candidates) {
			if (!item.videoId) continue;
			const existing = this.entries.get(item.videoId);
			if (existing && (existing.status === 'pending' || existing.status === 'running')) continue;
			if (existing && (existing.status === 'done' || existing.status === 'failed')) continue;
			this.entries.set(item.videoId, {
				...item,
				status: 'pending',
				addedAt: Date.now(),
			});
		}
		this.emitUpdate();
	}

	private kickDrain(): void {
		if (this.draining || this.disposed) return;
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.disposed) {
				const next = this.pickNextPending();
				if (!next) {
					this.maybeRefillFromAutoSource();
					const refilled = this.pickNextPending();
					if (!refilled) break;
				}
				const item = next ?? this.pickNextPending();
				if (!item) break;
				await this.rateGate.wait();
				await this.runOne(item);
				this.scheduleTerminalCleanup();
			}
		} finally {
			this.draining = false;
		}
	}

	private pickNextPending(): EnrichmentInternalEntry | null {
		for (const entry of this.entries.values()) {
			if (entry.status === 'pending') return entry;
		}
		return null;
	}

	private async runOne(item: EnrichmentInternalEntry): Promise<void> {
		item.status = 'running';
		this.emitUpdate();

		try {
			const apiKey = await loadYoutubeApiKey(this.plugin.app);
			if (!apiKey) throw new Error('No YouTube Data API key configured.');
			const result = item.sourceFile
				? await ingestYoutubeVideoMetadata(this.plugin, item.sourceFile, item.videoId)
				: await enrichYoutubeMetadataStandalone(this.plugin, item.videoId);
			if (result.status === 'created' || result.status === 'exists') {
				item.status = 'done';
				item.finishedAt = Date.now();
				const metadataFile = this.plugin.app.vault.getAbstractFileByPath(result.metadataPath ?? '');
				if (metadataFile instanceof TFile) {
					this.plugin.ingestionEvents?.emit('metadata-enriched', {
						videoId: item.videoId,
						metadataFile,
						sourceFile: item.sourceFile,
					});
				}
			} else if (result.status === 'no-api-key') {
				item.status = 'failed';
				item.error = 'No YouTube Data API key configured.';
				item.finishedAt = Date.now();
				this.autoEnabled = false;
			} else {
				item.status = 'failed';
				item.error = 'No video ID.';
				item.finishedAt = Date.now();
			}
		} catch (err) {
			item.status = 'failed';
			item.error = err instanceof Error ? err.message : String(err);
			item.finishedAt = Date.now();
		}
		this.emitUpdate();
	}

	private emitUpdate(): void {
		this.plugin.ingestionEvents?.emit('enrichment-queue-updated', { size: this.entries.size });
	}

	private scheduleTerminalCleanup(): void {
		const cutoff = Date.now() - TERMINAL_RETENTION_MS;
		let changed = false;
		for (const [id, entry] of this.entries) {
			if (entry.status !== 'done' && entry.status !== 'failed') continue;
			if ((entry.finishedAt ?? 0) > cutoff) continue;
			this.entries.delete(id);
			changed = true;
		}
		if (changed) this.emitUpdate();
	}
}

function statusRank(status: EnrichmentItemStatus): number {
	switch (status) {
		case 'running': return 0;
		case 'pending': return 1;
		case 'failed': return 2;
		case 'done': return 3;
	}
}
