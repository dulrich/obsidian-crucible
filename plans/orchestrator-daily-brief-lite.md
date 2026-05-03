# Orchestrator — Daily Brief Lite (Plan 2 of 4)

## Context

First concrete workflow on top of the orchestrator core. Updates today's daily note with a fenced "External Context" block containing FX rates and weather for three locations. No LLM, no judgement — pure HTTP fan-out plus a marked-block writer.

**Depends on:** Plan 1 (core). The `Orchestrator`, `JobStore`, `markdownBlocks`, and `dates` utilities must exist.

## What it does

1. Resolve today's daily note path via `${settings.dailyFolder}/${todayInTz(settings.orchestrationTimezone)}.md`.
2. If missing, invoke the existing materializer (`crucible:materialize-day-today`) so the note is created with the user's configured template (`_custom/day-template.md`). Wait for the file to exist.
3. Fan out four HTTP requests in parallel:
   - Frankfurter `https://api.frankfurter.app/latest?from=USD&to=MXN` (USD/MXN)
   - Frankfurter `https://api.frankfurter.app/latest?from=EUR&to=MXN` (EUR/MXN)
   - Open-Meteo for Guadalajara, MX (lat 20.6597, lon -103.3496)
   - Open-Meteo for Mt Vernon, WA (lat 48.4201, lon -122.3346)
   - Open-Meteo for Bolzano, IT (lat 46.4983, lon 11.3548)
   (5 requests total — listed three weather + two FX above; running them as `Promise.allSettled` so a single failure doesn't kill the run.)
4. Format each result into a single line. On per-source failure, render `*USD/MXN: lookup failed (HTTP 503)*`-style line.
5. Replace (or insert) the marked block in today's daily note.
6. Decide job outcome:
   - All 5 sources failed → job `failed`, record an error summarizing.
   - At least 1 succeeded → job `done`. If any source failed, set `partial: true` in job frontmatter and include a list of failed sources in `notes`.

## Output format inside the daily note

```md
## Daily Brief: External Context

<!-- orchestration:daily-brief-lite:start -->

**FX Rates** _(updated 2026-05-02 14:30 CST)_
- USD → MXN: 17.42
- EUR → MXN: 19.18

**Weather**
- Guadalajara, MX: 24°C, partly cloudy, wind 8 km/h
- Mt Vernon, WA: 12°C, light rain, wind 14 km/h
- Bolzano, IT: 18°C, clear, wind 5 km/h

<!-- orchestration:daily-brief-lite:end -->
```

If the marked block already exists in the note, replace its contents only. If absent, append the heading + block at the end of the note. Existing content (frontmatter, other sections) is never touched.

## Files to add

```
src/orchestration/workflows/DailyBriefLiteWorkflow.ts
src/orchestration/utils/fx.ts
src/orchestration/utils/weather.ts
```

## Files to modify

- `src/main.ts` — register the workflow + add `orchestrator-enqueue-daily-brief-lite` command.

## Implementation details

### `src/orchestration/utils/fx.ts`

```ts
export interface FxRate {
  base: string;       // "USD"
  quote: string;      // "MXN"
  rate: number;
  asOf: string;       // YYYY-MM-DD from API response
}

export async function fetchFxRate(base: string, quote: string): Promise<FxRate>;
```

Calls `https://api.frankfurter.app/latest?from=${base}&to=${quote}` via `requestUrl()`. Throws on non-200 or unexpected payload shape. Caller decides how to surface the error.

### `src/orchestration/utils/weather.ts`

```ts
export interface WeatherSnapshot {
  location: string;       // human-readable label
  temperatureC: number;
  description: string;    // mapped from weather_code
  windKmh: number;
}

export interface Coords { lat: number; lon: number; label: string; }

export const LOCATIONS: Coords[];   // 3 hardcoded entries

export async function fetchWeather(coords: Coords): Promise<WeatherSnapshot>;
```

Calls Open-Meteo:
```
https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lon}
  &current=temperature_2m,weather_code,wind_speed_10m
  &wind_speed_unit=kmh&temperature_unit=celsius
```

`weather_code` → text mapping per WMO codes (https://open-meteo.com/en/docs#weathervariables). Minimal mapping table for ~20 most common codes:

```ts
const WEATHER_CODES: Record<number, string> = {
  0: "clear",
  1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow",
  80: "rain showers", 81: "rain showers", 82: "violent showers",
  95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "thunderstorm w/ heavy hail",
};
```

Unknown codes render as `code N`.

### `src/orchestration/workflows/DailyBriefLiteWorkflow.ts`

```ts
export class DailyBriefLiteWorkflow implements Workflow {
  async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
```

Steps:

1. **Resolve daily note path.**
   ```ts
   const date = todayInTz(plugin.settings.orchestrationTimezone);
   const path = normalizePath(`${plugin.settings.dailyFolder}/${date}.md`);
   ```

2. **Ensure note exists.** If `app.vault.getAbstractFileByPath(path)` returns null:
   ```ts
   await plugin.chainManager.executeInternalCommand("crucible:materialize-day-today", {});
   // brief retry loop (up to 5 × 100ms) until the file appears
   ```
   If the file still doesn't exist after the wait, fail the job with `"Daily note could not be materialized at ${path}"`.

3. **Fan-out fetches.**
   ```ts
   const results = await Promise.allSettled([
     fetchFxRate("USD", "MXN"),
     fetchFxRate("EUR", "MXN"),
     ...LOCATIONS.map(fetchWeather),
   ]);
   ```

4. **Build the body.** Helper functions render each section. For rejected promises, render the `*Source: lookup failed (...)*` line.

5. **Update the note.**
   ```ts
   const file = app.vault.getAbstractFileByPath(path) as TFile;
   const content = await app.vault.read(file);
   const next = replaceMarkedBlock(content, "daily-brief-lite", body, "Daily Brief: External Context");
   await app.vault.modify(file, next);
   ```

6. **Return WorkflowResult.**
   - All 5 succeeded → `{ status: "done", outputPaths: [path], notes: "All sources OK" }`.
   - Mixed → `{ status: "done", outputPaths: [path], notes: "Partial: failed sources: USD/MXN, Bolzano weather" }`. Caller (Orchestrator) writes `partial: true` to the job frontmatter when notes start with `Partial:`.
   - All failed → `{ status: "failed", error: "All 5 external sources failed" }`.

## main.ts wiring

After Orchestrator is constructed:

```ts
import { DailyBriefLiteWorkflow } from "./orchestration/workflows/DailyBriefLiteWorkflow";

this.orchestrator.register("daily_brief_lite", new DailyBriefLiteWorkflow());

this.addCommand({
  id: "orchestrator-enqueue-daily-brief-lite",
  name: "Orchestrator: Enqueue daily brief lite",
  callback: () => void this.orchestrator.enqueue("daily_brief_lite"),
});
```

## Verification

1. `npm run build` — clean.
2. **Happy path on a fresh daily note:**
   - Delete today's daily note (or use a date that doesn't exist).
   - `Orchestrator: Enqueue daily brief lite` → notice "queued job …".
   - `Orchestrator: Run next` → daily note created via materializer; block appears under `## Daily Brief: External Context`; job moves to `done/`.
3. **Idempotent re-run:**
   - Run again → block contents replaced, no duplicate heading, surrounding content untouched.
4. **Partial failure:**
   - Block one of the API hosts (e.g., add `127.0.0.1 api.frankfurter.app` to `/etc/hosts`).
   - Run → job ends `done` with `partial: true` in frontmatter; failed lines show `*USD/MXN: lookup failed (...)*`; weather lines OK.
5. **Total failure:**
   - Disable network entirely.
   - Run → job moves to `failed/` with error summarizing all 5 failures.
6. **Marked-block fallback:**
   - Manually open today's note and remove the markers (keep the heading).
   - Run → markers re-inserted around fresh body; only this block is rewritten.
7. **Daily note exists already with unrelated content:**
   - Add a `## Daylogs` section above the brief block. Verify after re-run that Daylogs entries are untouched.

## Out of scope

- Configurable locations (hardcoded in v1).
- Configurable FX pairs (hardcoded in v1).
- Hourly forecasts.
- Caching responses across runs.
- Auto-running on calendar trigger.
