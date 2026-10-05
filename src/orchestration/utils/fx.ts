import { requestUrl } from 'obsidian';

export interface FxRate {
	base: string;
	quote: string;
	rate: number;
	asOf: string;
}

interface FrankfurterResponse {
	amount: number;
	base: string;
	date: string;
	rates: Record<string, number>;
}

export interface Currency {
	code: string;
	name: string;
}

export async function fetchCurrencies(): Promise<Currency[]> {
	const url = 'https://api.frankfurter.dev/v1/currencies';
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status !== 200) {
		throw new Error(`Frankfurter currencies: HTTP ${res.status}`);
	}
	const body = res.json as Record<string, string>;
	return Object.entries(body)
		.map(([code, name]) => ({ code, name }))
		.sort((a, b) => a.code.localeCompare(b.code));
}

export async function fetchFxRate(base: string, quote: string): Promise<FxRate> {
	// Frankfurter serves /latest with `cache-control: max-age=86400`, and the old
	// api.frankfurter.app host answers with a (cacheable) 301 to .dev. requestUrl
	// rides Electron's HTTP cache, so a plain URL replayed yesterday's rate for up
	// to 24h. Hit the canonical host and bust the cache with a per-call param.
	const url = `https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}&_=${Date.now()}`;
	const res = await requestUrl({ url, method: 'GET', throw: false, headers: { 'Cache-Control': 'no-cache' } });
	if (res.status !== 200) {
		throw new Error(`Frankfurter ${base}/${quote}: HTTP ${res.status}`);
	}
	const body = res.json as FrankfurterResponse;
	const rate = body?.rates?.[quote];
	if (typeof rate !== 'number' || !Number.isFinite(rate)) {
		throw new Error(`Frankfurter ${base}/${quote}: missing rate in response`);
	}
	return { base, quote, rate, asOf: body.date };
}
