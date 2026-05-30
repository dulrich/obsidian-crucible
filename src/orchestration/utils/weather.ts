import { requestUrl } from 'obsidian';

export interface Coords {
	label: string;
	lat: number;
	lon: number;
}

export interface WeatherSnapshot {
	location: string;
	highC: number;
	lowC: number;
	description: string;
}

export const LOCATIONS: Coords[] = [
	{ label: 'Guadalajara, MX', lat: 20.6597, lon: -103.3496 },
	{ label: 'Mt Vernon, WA', lat: 48.4201, lon: -122.3346 },
	{ label: 'Bolzano, IT', lat: 46.4983, lon: 11.3548 },
];

const WEATHER_CODES: Record<number, string> = {
	0: 'clear',
	1: 'mostly clear',
	2: 'partly cloudy',
	3: 'overcast',
	45: 'fog',
	48: 'rime fog',
	51: 'light drizzle',
	53: 'drizzle',
	55: 'heavy drizzle',
	61: 'light rain',
	63: 'rain',
	65: 'heavy rain',
	71: 'light snow',
	73: 'snow',
	75: 'heavy snow',
	80: 'rain showers',
	81: 'rain showers',
	82: 'violent showers',
	95: 'thunderstorm',
	96: 'thunderstorm w/ hail',
	99: 'thunderstorm w/ heavy hail',
};

interface OpenMeteoResponse {
	daily?: {
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		weather_code?: number[];
	};
}

export interface GeoResult {
	label: string;        // "City, CC"
	name: string;
	countryCode: string;
	admin1?: string;
	lat: number;
	lon: number;
}

interface OpenMeteoGeoResponse {
	results?: Array<{
		name: string;
		country_code?: string;
		admin1?: string;
		latitude: number;
		longitude: number;
	}>;
}

export async function geocodeLocation(query: string): Promise<GeoResult[]> {
	const q = query.trim();
	if (!q) return [];
	const params = new URLSearchParams({ name: q, count: '10', language: 'en', format: 'json' });
	const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status !== 200) return [];
	const body = res.json as OpenMeteoGeoResponse;
	return (body.results ?? []).map(r => ({
		name: r.name,
		countryCode: r.country_code ?? '',
		admin1: r.admin1,
		lat: r.latitude,
		lon: r.longitude,
		label: r.country_code ? `${r.name}, ${r.country_code}` : r.name,
	}));
}

export async function fetchWeather(coords: Coords, timezone: string): Promise<WeatherSnapshot> {
	const params = new URLSearchParams({
		latitude: coords.lat.toString(),
		longitude: coords.lon.toString(),
		daily: 'temperature_2m_max,temperature_2m_min,weather_code',
		temperature_unit: 'celsius',
		timezone,
		forecast_days: '1',
	});
	const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status !== 200) {
		throw new Error(`Open-Meteo ${coords.label}: HTTP ${res.status}`);
	}
	const body = res.json as OpenMeteoResponse;
	const daily = body?.daily;
	if (!daily) {
		throw new Error(`Open-Meteo ${coords.label}: missing 'daily' in response`);
	}
	const highC = daily.temperature_2m_max?.[0];
	const lowC = daily.temperature_2m_min?.[0];
	const code = daily.weather_code?.[0];
	if (typeof highC !== 'number' || typeof lowC !== 'number' || typeof code !== 'number') {
		throw new Error(`Open-Meteo ${coords.label}: incomplete daily forecast data`);
	}
	const description = WEATHER_CODES[code] ?? `code ${code}`;
	return { location: coords.label, highC, lowC, description };
}
