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

export function newJobId(type: string): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, '0');
	const stamp =
		`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
		`-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	const rand = Math.floor(Math.random() * 0x10000)
		.toString(16)
		.padStart(4, '0');
	const safeType = type.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
	return `${stamp}-${safeType}-${rand}`;
}
