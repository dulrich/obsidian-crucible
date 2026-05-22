export type SettledResult<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown };

export async function rateLimitedAllSettled<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	maxParallel: number,
	minIntervalMs: number,
): Promise<SettledResult<R>[]> {
	const results: SettledResult<R>[] = items.map(() => ({ status: 'rejected', reason: new Error('not started') }));
	let nextIdx = 0;
	let nextStartAllowed = 0;

	const reserveSlot = (): number => {
		const now = Date.now();
		const start = Math.max(now, nextStartAllowed);
		nextStartAllowed = start + minIntervalMs;
		return start - now;
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = nextIdx++;
			const item = items[i];
			if (i >= items.length || item === undefined) return;
			const wait = reserveSlot();
			if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
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
