import { requestUrl } from 'obsidian';

export interface Coords {
	label: string;
	lat: number;
	lon: number;
}

export interface WeatherSnapshot {
	location: string;
	temperatureC: number;
	description: string;
	windKmh: number;
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
	current?: {
		temperature_2m?: number;
		weather_code?: number;
		wind_speed_10m?: number;
	};
}

export async function fetchWeather(coords: Coords): Promise<WeatherSnapshot> {
	const params = new URLSearchParams({
		latitude: coords.lat.toString(),
		longitude: coords.lon.toString(),
		current: 'temperature_2m,weather_code,wind_speed_10m',
		wind_speed_unit: 'kmh',
		temperature_unit: 'celsius',
	});
	const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status !== 200) {
		throw new Error(`Open-Meteo ${coords.label}: HTTP ${res.status}`);
	}
	const body = res.json as OpenMeteoResponse;
	const current = body?.current;
	if (!current) {
		throw new Error(`Open-Meteo ${coords.label}: missing 'current' in response`);
	}
	const temperatureC = current.temperature_2m;
	const code = current.weather_code;
	const windKmh = current.wind_speed_10m;
	if (typeof temperatureC !== 'number' || typeof code !== 'number' || typeof windKmh !== 'number') {
		throw new Error(`Open-Meteo ${coords.label}: incomplete current weather data`);
	}
	const description = WEATHER_CODES[code] ?? `code ${code}`;
	return { location: coords.label, temperatureC, description, windKmh };
}
