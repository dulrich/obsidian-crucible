// A counting semaphore bounding how many drain workers run a job concurrently
// across all types (the global concurrency cap). The capacity is read from a
// provider each acquire so a settings change takes effect for new acquisitions
// without rebuilding the semaphore. Slots are transferred directly to the next
// waiter on release, so capacity is never exceeded under interleaved awaits.
export class Semaphore {
	private inUse = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly maxProvider: () => number) {}

	async acquire(): Promise<void> {
		if (this.inUse < Math.max(1, this.maxProvider())) {
			this.inUse++;
			return;
		}
		await new Promise<void>(resolve => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		// Hand the slot straight to the next waiter (keep inUse unchanged); only
		// decrement when no one is waiting.
		if (next) next();
		else this.inUse--;
	}
}
