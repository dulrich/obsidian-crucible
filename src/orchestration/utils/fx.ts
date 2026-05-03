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

export async function fetchFxRate(base: string, quote: string): Promise<FxRate> {
	const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });
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
