export function todayInTz(timezone: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date());
}

export function nowTimeInTz(timezone: string): string {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone: timezone,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	return fmt.format(new Date()).replace(/:/g, '-');
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

// Batch fan-out workflows (image_describe_batch, search_upsert_batch, ...) can mint dozens of
// job ids inside a single millisecond in a tight synchronous loop. The stamp alone (even with
// milliseconds) can't disambiguate those, so a module-level monotonic counter breaks ties in
// mint order: it resets to 0 whenever the millisecond advances and increments on every id
// minted within the same millisecond. Combined with `JobStore.listFolder`'s
// `created`/id tie-break, this makes claim order (and therefore display order) match mint
// order instead of falling through to the random suffix.
let lastJobIdMs = -1;
let jobIdCounter = 0;

function nextJobIdCounter(ms: number): number {
	if (ms === lastJobIdMs) {
		jobIdCounter += 1;
	} else {
		lastJobIdMs = ms;
		jobIdCounter = 0;
	}
	return jobIdCounter;
}

export function newJobId(type: string): string {
	const now = new Date();
	const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
	const stamp =
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
		`-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}`;
	// Monotonic component sorts first (fixed-width hex, so it dominates the lexicographic
	// compare); the random suffix stays after it as a belt-and-suspenders uniqueness guard.
	const counter = nextJobIdCounter(now.getTime())
		.toString(16)
		.padStart(4, '0');
	const rand = Math.floor(Math.random() * 0x10000)
		.toString(16)
		.padStart(4, '0');
	const safeType = type.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
	return `${stamp}-${safeType}-${counter}${rand}`;
}
