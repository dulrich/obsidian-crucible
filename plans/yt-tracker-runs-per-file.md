# YT Tracker: One Intake File Per Run

## Context

In the previous session I made the YT tracker re-runs same-day work via two heuristics: (1) exclude today's intake from the seen-set so morning's videos get re-listed, and (2) a skip-write guard if no fresh videos. This works but is brittle — the body still risks losing entries (e.g. a video rotates out of RSS between runs), and "today is special" logic accumulates edge cases.

The cleaner model: each run produces its own intake file with a timestamp-suffixed filename. No file is ever overwritten. Diff mode treats *all* prior intake files (including earlier same-day runs) as seen. This eliminates the today-exclusion, the skip-write guard, and the modify-vs-create branch in `writeIntakeNote`.

## Design

### 1. Filename per run

Replace the current `${INTAKE_ROOT}/${date}.md` (date-only) with `${INTAKE_ROOT}/${date}T${time}.md` where both date and time are in the configured timezone (`orchestrationTimezone`):

- Example: `_crucible/orchestration/youtube/new-videos/2026-05-09T14-22-08.md`
- Lex-sortable, globally unique, matches the `_crucible/cli-runs/` naming convention.

Add a small helper to `src/orchestration/utils/dates.ts`:

```ts
export function nowTimeInTz(timezone: string): string {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
    return fmt.format(new Date()).replace(/:/g, '-');
}
```

(The existing `todayInTz` already gives the date portion.)

### 2. Workflow simplifications

In `src/orchestration/workflows/YoutubeTrackerWorkflow.ts`:

- **`buildSeenIdSet`**: drop the `todayDate` parameter and the `isTodayIntake` check. Every intake file (including earlier same-day runs) contributes its `video_ids:` to the seen set when diff mode is on.
- **`run()`**: drop the today-exists / skip-write guard added in the prior session. Each run computes fresh, then writes a new file with a unique name.
- **`writeIntakeNote()`**: drop the `app.vault.modify()` branch — file always gets created (collision impossible with the timestamped name).

### 3. New setting: empty runs

Add `orchestrationYoutubeTrackerWriteEmptyRuns: boolean` to `CrucibleSettings` (default `false`). Behavior:

- `false` (default): if no new videos, the run returns `done` with a "no new videos" note and writes nothing. Folder stays clean.
- `true`: always write a file, even when empty (audit trail of run cadence).

UI: a toggle in the YT tracker settings section under the existing diff-mode toggle, with a clear description of the tradeoff.

## Files to modify

- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — filename change, remove today-exclusion, remove skip-write guard, remove modify-branch, honor new empty-runs setting.
- `src/orchestration/utils/dates.ts` — add `nowTimeInTz` helper.
- `src/types.ts` — add `orchestrationYoutubeTrackerWriteEmptyRuns: boolean` to `CrucibleSettings` and `DEFAULT_SETTINGS`.
- `src/settings.ts` — add the empty-runs toggle in `renderEditYoutubeTrackerWorkflow`.

## Reuse / existing helpers

- `todayInTz` (`src/orchestration/utils/dates.ts:1`) — still used for the date prefix in the filename.
- `ingestProperty` / `addId` (`YoutubeTrackerWorkflow.ts:182-201`) — unchanged; still extracts IDs from frontmatter properties.
- `INTAKE_ROOT` and `QUEUE_SCAN_SKIP_PREFIX` constants — unchanged.

## What gets removed

- `todayDate` parameter from `buildSeenIdSet` and the `isTodayIntake` filter inside it.
- The `todayIntakeExists` / `totalNew === 0 && todayIntakeExists` skip-write block in `run()`.
- The `app.vault.getAbstractFileByPath(path) instanceof TFile` modify-vs-create branch in `writeIntakeNote()`.

## Verification

1. **Same-day double-run**: enqueue + run YT tracker twice within ~30s. Confirm two distinct files exist in `_crucible/orchestration/youtube/new-videos/` with timestamp suffixes; neither overwrites the other.
2. **Diff mode across runs**: with diff mode on, run 1 surfaces N videos. Run 2 should surface only videos posted between run 1 and run 2 (typically 0). The new run's `video_ids:` frontmatter should be empty or contain only genuinely new IDs.
3. **Diff mode off**: same scenario as #2, but with diff mode off, run 2 should re-list all videos that have no vault note. Both files coexist.
4. **Empty-run toggle**:
   - With `orchestrationYoutubeTrackerWriteEmptyRuns = false` and diff mode on, run twice in a row with no new videos: only the first run produces a file.
   - Flip to `true`, run again: a second file is produced even with `videos_total: 0`.
5. **Build**: `npm run build` passes.
6. **Lint**: `npx eslint src/orchestration/workflows/YoutubeTrackerWorkflow.ts src/orchestration/utils/dates.ts src/types.ts src/settings.ts` passes.
