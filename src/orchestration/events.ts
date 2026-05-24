import type { TFile } from 'obsidian';

export type IngestionEventName =
	| 'clipping-captured'
	| 'transcript-refined'
	| 'tracker-run'
	| 'metadata-enriched'
	| 'enrichment-queue-updated'
	| 'orchestration-queue-updated';

export interface IngestionEventPayloads {
	'clipping-captured': { file: TFile };
	'transcript-refined': { file: TFile; model?: string };
	'tracker-run': { kind: 'blog' | 'youtube'; runFile: TFile | null; status: 'done' | 'failed' };
	'metadata-enriched': { videoId: string; metadataFile: TFile; sourceFile?: TFile };
	'enrichment-queue-updated': { size: number };
	'orchestration-queue-updated': { queued: number; running: number };
}

type Listener<E extends IngestionEventName> = (payload: IngestionEventPayloads[E]) => void;

export class IngestionEventBus {
	private readonly listeners = new Map<IngestionEventName, Set<Listener<IngestionEventName>>>();

	on<E extends IngestionEventName>(event: E, listener: Listener<E>): () => void {
		let bucket = this.listeners.get(event);
		if (!bucket) {
			bucket = new Set();
			this.listeners.set(event, bucket);
		}
		bucket.add(listener as Listener<IngestionEventName>);
		return () => this.off(event, listener);
	}

	off<E extends IngestionEventName>(event: E, listener: Listener<E>): void {
		const bucket = this.listeners.get(event);
		if (!bucket) return;
		bucket.delete(listener as Listener<IngestionEventName>);
		if (bucket.size === 0) this.listeners.delete(event);
	}

	emit<E extends IngestionEventName>(event: E, payload: IngestionEventPayloads[E]): void {
		const bucket = this.listeners.get(event);
		if (!bucket) return;
		for (const listener of Array.from(bucket)) {
			try {
				(listener as Listener<E>)(payload);
			} catch (err) {
				console.error(`[crucible] ingestion event listener for "${event}" threw:`, err);
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}
