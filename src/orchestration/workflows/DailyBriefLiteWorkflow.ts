import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { fetchFxRate, FxRate } from '../utils/fx';
import { fetchWeather, WeatherSnapshot } from '../utils/weather';
import { insertIntoSection, isSectionEmpty } from '../../sections';
import { periodDisabledMessage } from '../../periods';

export class DailyBriefLiteWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		if (!plugin.settings.dailyEnabled) {
			return { status: 'failed', error: periodDisabledMessage('daily') };
		}
		const date = todayInTz(tz);
		const dailyFolder = plugin.settings.dailyFolder;
		const path = normalizePath(`${dailyFolder}/${date}.md`);

		const file = await this.ensureDailyNote(plugin, path);
		if (!file) {
			return { status: 'failed', error: `Daily note could not be materialized at ${path}` };
		}

		const targetSection = (plugin.settings.orchestrationDailyBriefTargetSection ?? '').trim();
		const content = await app.vault.read(file);

		if (targetSection && !isSectionEmpty(content, targetSection)) {
			return {
				status: 'done',
				outputPaths: [file.path],
				notes: 'Section already has content, skipped.',
			};
		}

		const fxPairs = plugin.settings.orchestrationDailyBriefFxPairs;
		const locations = plugin.settings.orchestrationDailyBriefWeatherLocations;

		if (fxPairs.length === 0 && locations.length === 0) {
			return {
				status: 'done',
				outputPaths: [file.path],
				notes: 'No FX pairs or weather locations configured, skipped.',
			};
		}

		const fxResults = await Promise.allSettled(fxPairs.map(p => fetchFxRate(p.base, p.quote)));
		const weatherResults = await Promise.allSettled(locations.map(loc => fetchWeather(loc, tz)));

		const failures: string[] = [];
		const fxLines: string[] = fxResults.map((r, i) => {
			const pair = fxPairs[i]!;
			if (r.status === 'fulfilled') return formatFxLine(pair.label, r.value);
			failures.push(pair.label);
			return `- ${pair.label}: *lookup failed (${describeReason(r.reason)})*`;
		});
		const weatherLines: string[] = weatherResults.map((r, i) => {
			const loc = locations[i]!;
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
		const sections: string[] = [];
		if (fxLines.length) sections.push([`**FX Rates** _(updated ${stamp})_`, ...fxLines].join('\n'));
		if (weatherLines.length) sections.push(['**Weather**', ...weatherLines].join('\n'));
		const body = sections.join('\n\n');

		// Pad with blank lines so the block is visually separated from any
		// existing content above and the next section below.
		const payload = `\n${body.trim()}\n`;
		const next = insertIntoSection(content, targetSection, payload, 'append');
		await app.vault.modify(file, next);

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
	return `- ${label}: ${rate.rate.toFixed(2)} _(as of ${rate.asOf})_`;
}

function formatWeatherLine(snap: WeatherSnapshot): string {
	const high = Math.round(snap.highC);
	const low = Math.round(snap.lowC);
	return `- ${snap.location}: ↑${high}°C / ↓${low}°C, ${snap.description}`;
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
