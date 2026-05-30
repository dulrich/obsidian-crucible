# Daily Brief Lite — autocomplete for currency & weather location

## Context

In **Crucible → Settings → Orchestrate → Daily Brief Lite**, the currency-pair and
weather-location editors are plain free-text fields (`src/settings.ts:2252-2342`). The user
must hand-type ISO currency codes, type a label, and manually look up/enter decimal-degree
coordinates — error-prone and disconnected from the live data the workflow actually uses.

The Daily Brief workflow fetches its live data from two providers
(`DailyBriefLiteWorkflow.ts:49-50`):
- **FX rates** → Frankfurter (`api.frankfurter.app`) via `fetchFxRate()` (`src/orchestration/utils/fx.ts`).
- **Weather** → Open-Meteo (`api.open-meteo.com`) via `fetchWeather()` (`src/orchestration/utils/weather.ts`).

Both providers expose discovery endpoints we are not yet using:
- Frankfurter `GET /currencies` → `{ "USD": "United States Dollar", ... }` (full supported list).
- Open-Meteo geocoding `GET geocoding-api.open-meteo.com/v1/search?name=…` → results with
  `name`, `country_code`, `latitude`, `longitude`, `admin1`.

**Goal:** attach autocomplete dropdowns to the edit controls, backed by these same providers.
Selecting a suggestion auto-fills the relevant fields:
- **Currency:** picking a base/quote code fills it; when both codes are set and the label is
  empty, auto-fill the label from template `{from} → {to}` (e.g. `USD → MXN`).
- **Weather:** picking a location (fuzzy-matched live, shown as `City-name, CC`) fills the
  label and the latitude/longitude coordinates.

Decisions confirmed with user: weather uses **live Open-Meteo geocoding** (any city
worldwide); auto-title uses the **`→` arrow** to match existing defaults. Because the global
currency list and geocoding results change rarely, **persist these API responses to the cache**
(in plugin settings, each entry tagged with its retrieval datetime) so repeated typing doesn't
re-hit the network. Provide red **"Clear cache"** buttons next to the existing "Add currency
pair" / "Add location" buttons to force a refresh.

## Implementation

### 1. Provider data functions (pure fetches — caching lives in settings, see §2/§4)

**`src/orchestration/utils/fx.ts`** — add a currency-list fetch:
```ts
export interface Currency { code: string; name: string; }

export async function fetchCurrencies(): Promise<Currency[]> {
    const url = 'https://api.frankfurter.app/currencies';
    const res = await requestUrl({ url, method: 'GET', throw: false });
    if (res.status !== 200) throw new Error(`Frankfurter currencies: HTTP ${res.status}`);
    const body = res.json as Record<string, string>;
    return Object.entries(body)
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.code.localeCompare(b.code));
}
```

**`src/orchestration/utils/weather.ts`** — add a geocoding lookup:
```ts
export interface GeoResult {
    label: string;        // "City, CC"
    name: string;
    countryCode: string;
    admin1?: string;
    lat: number;
    lon: number;
}

interface OpenMeteoGeoResponse {
    results?: Array<{ name: string; country_code?: string; admin1?: string; latitude: number; longitude: number; }>;
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
```

### 2. Persisted cache shape — `src/types.ts`

The cache lives in plugin settings (`data.json`) so it survives reloads and can be cleared via a
button. Add to the settings interface (and `DEFAULT_SETTINGS`), importing `Currency`/`GeoResult`
from the utils:
```ts
export interface CurrencyCache { fetchedAt: string; currencies: Currency[]; }
export interface GeocodeCacheEntry { fetchedAt: string; results: GeoResult[]; }

// in CrucibleSettings:
orchestrationDailyBriefCurrencyCache?: CurrencyCache;            // default: undefined
orchestrationDailyBriefGeocodeCache: Record<string, GeocodeCacheEntry>;  // default: {}
```
Geocode cache is keyed by the normalized (trimmed/lowercased) query string. `fetchedAt` is an
ISO timestamp recorded at retrieval.

### 3. Suggester classes — `src/suggesters.ts`

Follow the existing `CommandSuggest` pattern (extends Obsidian `AbstractInputSuggest`, uses
`prepareFuzzySearch`). Add `sleep` import from `obsidian`. To keep `suggesters.ts` decoupled
from the plugin class, the suggesters take **cache load/save callbacks** (wired in settings.ts
to `plugin.settings` + `plugin.saveSettings()`), plus an `onSelect` callback.

**`CurrencySuggest extends AbstractInputSuggest<Currency>`**
- ctor: `(app, inputEl, loadCache, saveCache, onSelect)`.
- `getSuggestions(q)` — `async`: read cache via `loadCache()`; if absent, `await fetchCurrencies()`,
  then `await saveCache({ fetchedAt: new Date().toISOString(), currencies })`. Fuzzy-match the
  cached list on `${code} ${name}` (empty query → first 100). `AbstractInputSuggest.getSuggestions`
  accepts `T[] | Promise<T[]>`.
- `renderSuggestion(c, el)` — `${c.code} — ${c.name}`.
- `selectSuggestion(c)` — `this.inputEl.value = c.code; this.onSelect(c); this.close();`.

**`LocationSuggest extends AbstractInputSuggest<GeoResult>`**
- ctor: `(app, inputEl, loadCache, saveCache, onSelect)`.
- `getSuggestions(q)` — `async`, with min-length + debounce, checking the per-query cache first:
  ```ts
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const cached = this.loadCache(s);
  if (cached) return cached.results;
  this.lastQuery = s;
  await sleep(250);
  if (this.lastQuery !== s) return [];          // superseded by newer keystroke
  const results = await geocodeLocation(s);
  await this.saveCache(s, { fetchedAt: new Date().toISOString(), results });
  return results;
  ```
- `renderSuggestion(g, el)` — primary line `g.label`; muted secondary line `g.admin1` if present.
- `selectSuggestion(g)` — `this.inputEl.value = g.label; this.onSelect(g); this.close();`.

### 4. Wire into settings — `src/settings.ts` `renderEditDailyBriefWorkflow()`

Import `CurrencySuggest`, `LocationSuggest` from `./suggesters` and `Notice` from `obsidian`.

**Currency rows (lines ~2252-2291):**
- Fix stale provider text: `'FX rates to fetch from api.frankfurter.app.'` (currently says
  `open.er-api.com`).
- Capture the three `TextComponent`s (base, quote, label) instead of discarding them.
- Attach `CurrencySuggest` to the base input and the quote input, wiring its cache callbacks to
  `this.plugin.settings.orchestrationDailyBriefCurrencyCache` (load) and a setter that assigns it
  + `await this.plugin.saveSettings()`. On select, set `pair.base`/`pair.quote` (uppercased),
  push the value back into the input (`baseText.setValue(...)`), call `maybeAutoTitle()`, then
  `saveSettings()`.
- `maybeAutoTitle()`: if `pair.label` is empty and both `pair.base` and `pair.quote` are set,
  set `pair.label = `${pair.base} → ${pair.quote}`` and `labelText.setValue(pair.label)`.
- Also call `maybeAutoTitle()` from the existing base/quote `onChange` handlers so manual typing
  triggers the same auto-title behavior.

**"Add currency pair" row** — add a second, red button on the same `Setting`:
```ts
.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
    this.plugin.settings.orchestrationDailyBriefCurrencyCache = undefined;
    await this.plugin.saveSettings();
    new Notice('Currency list cache cleared');
}));
```
(`ButtonComponent.setWarning()` applies Obsidian's red `mod-warning` style.)

**Weather rows (lines ~2293-2342):**
- Capture the label, lat, and lon `TextComponent`s.
- Attach `LocationSuggest` to the label input, wiring cache callbacks to
  `this.plugin.settings.orchestrationDailyBriefGeocodeCache` (load by key / set by key + save).
  On select: `loc.label = g.label; loc.lat = g.lat; loc.lon = g.lon;` then
  `latText.setValue(String(g.lat)); lonText.setValue(String(g.lon)); labelText.setValue(g.label);`
  then `saveSettings()`.
- Keep the manual lat/lon number inputs unchanged for fine-tuning.

**"Add location" row** — add a red "Clear cache" button (same pattern) that resets
`orchestrationDailyBriefGeocodeCache = {}`, saves, and shows `new Notice('Location cache cleared')`.

### 5. Document quirk — `AGENTS.md` `## Quirks` (line 120)

Add a short note: Daily Brief Lite FX uses **Frankfurter** (`api.frankfurter.app`), not
er-api/open-meteo; `CurrencySuggest`/`LocationSuggest` use **async `getSuggestions`** (Obsidian
allows returning a `Promise`), `LocationSuggest` debounces live Open-Meteo geocoding with a
`sleep` + `lastQuery` guard, and both **persist responses to the settings cache** (keyed by
query for geocoding, each with a `fetchedAt`), cleared only via the red Clear-cache buttons.

## Files touched
- `src/orchestration/utils/fx.ts` — `fetchCurrencies()` + `Currency` interface.
- `src/orchestration/utils/weather.ts` — `geocodeLocation()` + `GeoResult` interface.
- `src/types.ts` — `CurrencyCache`/`GeocodeCacheEntry` + two cache fields in settings & `DEFAULT_SETTINGS`.
- `src/suggesters.ts` — `CurrencySuggest`, `LocationSuggest` (cache-callback driven).
- `src/settings.ts` — wire suggesters + auto-fill + red "Clear cache" buttons into
  `renderEditDailyBriefWorkflow()`, fix provider text.
- `AGENTS.md` — Quirks note.

## Verification
1. `npm run build` (or the project's tsc/esbuild build) — confirm no type errors; `getSuggestions`
   async return types compile against `AbstractInputSuggest`.
2. In Obsidian: open **Settings → Orchestrate → Daily Brief Lite**.
   - Currency: clear a pair's label, type into base/quote → dropdown of `CODE — Name` appears;
     selecting fills the code; with both set + empty label, label auto-fills as `USD → MXN`.
   - Weather: clear/add a location, type a city name in the label → live `City, CC` results
     appear; selecting fills label and populates lat/lon.
   - Caching: after a currency/location lookup, inspect `data.json` and confirm a cache entry
     with a `fetchedAt` timestamp exists; re-typing the same query returns instantly with no new
     network request (check devtools Network). Click the red **Clear cache** buttons → cache
     fields reset (`undefined` / `{}`), a Notice appears, and the next lookup re-fetches.
3. Run the Daily Brief Lite workflow once to confirm the selected pairs/locations still fetch
   correctly (codes valid for Frankfurter, coords valid for Open-Meteo).
