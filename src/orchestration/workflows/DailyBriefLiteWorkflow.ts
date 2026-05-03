import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { fetchFxRate, FxRate } from '../utils/fx';
import { fetchWeather, LOCATIONS, WeatherSnapshot } from '../utils/weather';
import { replaceMarkedBlock } from '../utils/markdownBlocks';

const BLOCK_KEY = 'daily-brief-lite';
const HEADING = 'Daily Brief: External Context';
const FX_PAIRS: Array<{ base: string; quote: string; label: string }> = [
	{ base: 'USD', quote: 'MXN', label: 'USD → MXN' },
	{ base: 'EUR', quote: 'MXN', label: 'EUR → MXN' },
];

export class DailyBriefLiteWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		const date = todayInTz(tz);
		const dailyFolder = plugin.settings.dailyFolder;
		const path = normalizePath(`${dailyFolder}/${date}.md`);

		const file = await this.ensureDailyNote(plugin, path);
		if (!file) {
			return { status: 'failed', error: `Daily note could not be materialized at ${path}` };
		}

		const fxResults = await Promise.allSettled(FX_PAIRS.map(p => fetchFxRate(p.base, p.quote)));
		const weatherResults = await Promise.allSettled(LOCATIONS.map(loc => fetchWeather(loc)));

		const failures: string[] = [];
		const fxLines: string[] = fxResults.map((r, i) => {
			const pair = FX_PAIRS[i]!;
			if (r.status === 'fulfilled') return formatFxLine(pair.label, r.value);
			failures.push(pair.label);
			return `- ${pair.label}: *lookup failed (${describeReason(r.reason)})*`;
		});
		const weatherLines: string[] = weatherResults.map((r, i) => {
			const loc = LOCATIONS[i]!;
			if (r.status === 'fulfilled') return formatWeatherLine(r.value);
			failures.push(loc.label);
			return `- ${loc.label}: *lookup failed (${describeReason(r.reason)})*`;
		});

		const successCount = (fxResults.length + weatherResults.length) - failures.length;
		if (successCount === 0) {
			return {
				status: 'failed',
				error: `All ${fxResults.length + weatherResults.length} external sources failed: ${failures.join(', ')}`,
			};
		}

		const stamp = formatStamp(tz);
		const body = [
			`**FX Rates** _(updated ${stamp})_`,
			...fxLines,
			'',
			'**Weather**',
			...weatherLines,
		].join('\n');

		const content = await app.vault.read(file);
		const next = replaceMarkedBlock(content, BLOCK_KEY, body, HEADING);
		if (next !== content) {
			await app.vault.modify(file, next);
		}

		const notes = failures.length === 0
			? 'All sources OK'
			: `Partial: failed sources: ${failures.join(', ')}`;

		return {
			status: 'done',
			outputPaths: [file.path],
			notes,
		};
	}

	private async ensureDailyNote(plugin: WorkflowContext['plugin'], path: string): Promise<TFile | null> {
		const app = plugin.app;
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		await plugin.chainManager.executeInternalCommand('crucible:materialize-day-today', {});

		for (let attempt = 0; attempt < 5; attempt++) {
			await sleep(100);
			const f = app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) return f;
		}
		return null;
	}
}

function formatFxLine(label: string, rate: FxRate): string {
	return `- ${label}: ${rate.rate.toFixed(4)} _(as of ${rate.asOf})_`;
}

function formatWeatherLine(snap: WeatherSnapshot): string {
	const temp = Number.isInteger(snap.temperatureC) ? snap.temperatureC.toString() : snap.temperatureC.toFixed(1);
	const wind = Number.isInteger(snap.windKmh) ? snap.windKmh.toString() : snap.windKmh.toFixed(1);
	return `- ${snap.location}: ${temp}°C, ${snap.description}, wind ${wind} km/h`;
}

function formatStamp(tz: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZoneName: 'short',
	});
	return fmt.format(new Date()).replace(',', '');
}

function describeReason(reason: unknown): string {
	if (reason instanceof Error) return reason.message;
	if (typeof reason === 'string') return reason;
	return 'unknown error';
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
