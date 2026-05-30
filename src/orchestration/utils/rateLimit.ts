export type SettledResult<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown };

/**
 * The canonical rate-limit primitive. Hands out time slots spaced at least
 * `minIntervalMs` apart, so callers — whether a parallel batch runner or a
 * single-threaded drain — pace their requests through one shared implementation
 * instead of reinventing the spacing math. Tracks only the next allowed start
 * time, so it is safe to share across the workers of one batch.
 */
export class MinIntervalGate {
	private nextStartAllowed = 0;

	constructor(private minIntervalMs: number) {}

	setIntervalMs(ms: number): void {
		this.minIntervalMs = Math.max(0, ms);
	}

	/** Reserves the next slot and returns how long (ms) to wait before using it. */
	reserve(): number {
		if (this.minIntervalMs <= 0) return 0;
		const now = Date.now();
		const start = Math.max(now, this.nextStartAllowed);
		this.nextStartAllowed = start + this.minIntervalMs;
		return start - now;
	}

	/** Reserves the next slot and awaits until it is the caller's turn. */
	async wait(): Promise<void> {
		const ms = this.reserve();
		if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
	}
}

export async function rateLimitedAllSettled<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	maxParallel: number,
	minIntervalMs: number,
): Promise<SettledResult<R>[]> {
	const results: SettledResult<R>[] = items.map(() => ({ status: 'rejected', reason: new Error('not started') }));
	let nextIdx = 0;
	const gate = new MinIntervalGate(minIntervalMs);

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = nextIdx++;
			const item = items[i];
			if (i >= items.length || item === undefined) return;
			await gate.wait();
			try {
				results[i] = { status: 'fulfilled', value: await fn(item) };
			} catch (reason) {
				results[i] = { status: 'rejected', reason };
			}
		}
	};

	const workerCount = Math.min(Math.max(1, maxParallel), items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
