import type CruciblePlugin from '../main';
import type { Orchestrator } from './Orchestrator';

export class OrchestrationAutoRunner {
	private enabled: boolean;
	private draining = false;
	private disposed = false;
	private unsubscribe: (() => void) | null = null;

	constructor(private readonly plugin: CruciblePlugin, private readonly orchestrator: Orchestrator) {
		this.enabled = plugin.settings.orchestrationQueueAutorunEnabled === true;
		const bus = plugin.ingestionEvents;
		if (bus) {
			this.unsubscribe = bus.on('orchestration-queue-updated', () => this.kickDrain());
		}
		this.kickDrain();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) this.kickDrain();
	}

	async runOnce(): Promise<void> {
		if (this.draining || this.disposed) return;
		this.draining = true;
		try {
			await this.orchestrator.runNext();
		} finally {
			this.draining = false;
		}
	}

	private kickDrain(): void {
		if (!this.enabled || this.draining || this.disposed) return;
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.disposed && this.enabled) {
				const queued = await this.plugin.jobStore.listFolder('queued');
				if (queued.length === 0) break;
				const job = await this.orchestrator.runNext();
				if (!job) break;
			}
		} finally {
			this.draining = false;
		}
	}
}
