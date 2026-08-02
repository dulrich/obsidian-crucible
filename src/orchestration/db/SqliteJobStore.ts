import { logWarn } from '../../log';
import { CANCELLED_BEFORE_RUN } from '../cancellation';
import { defaultLaneForPriority } from '../lanes';
import type { JobLane, JobPriority, JobStatus, JobType } from '../types';
import type { DbJobRow, JobListOrder, NewJobInput, SqliteDatabase, TransitionPatch } from './types';

/**
 * The storage layer for the DB-backed job queue (thq WP-5). Wraps a `SqliteDatabase`
 * (from `openJobsDb` in production, or a `:memory:` handle / test double in tests) and
 * exposes the semantics the queue-db investigation and the WP-5 brief pinned:
 * mint-order claim ordering, atomic claim, crash-lease recovery, dedupe +
 * lane/priority promotion, deferral, age-based terminal retention, and the field
 * writers that today live on `JobStore` (`src/orchestration/JobStore.ts`) as
 * `updateFrontmatter` calls and here become single UPDATE statements.
 *
 * This class does not implement `JobBackend` and is not wired into `Orchestrator` —
 * that's `DbJobBackend`, WP-6. Nothing here decides *when* to claim, promote, or
 * dedupe; those decisions stay with the caller (explicitly true for promotion per the
 * brief's item 5, and applied consistently to insert defaults and dedupe lookups too).
 */
export class SqliteJobStore {
	/** One random token per open process instance (i.e. per plugin load), not per
	 * store call. `recoverStale` treats any `running` row whose `claim_token` isn't
	 * this token as orphaned by a since-dead process — see its doc comment. */
	readonly processToken: string;

	private static readonly CLAIM_CANDIDATE_LIMIT = 50;

	constructor(private readonly db: SqliteDatabase, options: { processToken?: string } = {}) {
		this.processToken = options.processToken ?? mintProcessToken();
	}

	close(): void {
		this.db.close();
	}

	// ---- Insert -----------------------------------------------------------------

	/** Inserts a new `queued` row. `id`/`created` are minted by the caller
	 * (`newJobId`/`nowIso`); lane defaults from priority the same way
	 * `JobStore.enqueue` does (`defaultLaneForPriority`, imported rather than
	 * reimplemented so the two can't drift). An empty/falsy `dedupeKey` is stored as
	 * NULL (never collapses — see `findActive`). */
	insert(input: NewJobInput): DbJobRow {
		const priority: JobPriority = input.priority ?? 'normal';
		const lane: JobLane = input.lane ?? defaultLaneForPriority(priority);
		const dedupeKey = input.dedupeKey ? input.dedupeKey : null;
		const deferUntil = input.deferUntil ?? null;

		this.db.prepare(`
			INSERT INTO jobs (id, type, status, lane, priority, created, params, output_paths, dedupe_key, defer_until)
			VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.id,
			input.type,
			lane,
			priority,
			input.created,
			JSON.stringify(input.params ?? {}),
			JSON.stringify([]),
			dedupeKey,
			deferUntil,
		);

		const row = this.get(input.id);
		if (!row) throw new Error(`SqliteJobStore.insert: row vanished immediately after insert (${input.id})`);
		return row;
	}

	// ---- Reads --------------------------------------------------------------------

	get(id: string): DbJobRow | null {
		const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
		return row ? mapRow(row) : null;
	}

	/** Rows in claim order by default — `ORDER BY lane_rank, priority_rank, created,
	 * id`, the same comparator `claimNext` uses (see its doc comment for the
	 * rank-map citation). `options.order: 'recency'` (WP-G3) switches to `settled_at
	 * DESC, id DESC` instead — for a *settled* status (done/failed/cancelled) claim
	 * order shows the oldest retained rows first, burying recent settlements behind
	 * them; recency order is what a settled-bucket UI wants. `'recency'` is a display
	 * ordering only — `claimNext`/`selectClaimCandidates`/`findActive` never call
	 * `list` and are untouched by this option. `limit` follows SQLite's own
	 * convention: omitted/negative means no limit. `type` narrows to one job type
	 * *inside* the statement, so it composes with `limit` correctly (filtering a
	 * limited page in JS would silently return fewer rows than asked for). */
	list(status: JobStatus, options: { limit?: number; offset?: number; type?: JobType; order?: JobListOrder } = {}): DbJobRow[] {
		const limit = options.limit ?? -1;
		const offset = options.offset ?? 0;
		const typeFilter = options.type ? ' AND type = ?' : '';
		const orderBy = options.order === 'recency'
			? 'settled_at DESC, id DESC'
			: 'lane_rank ASC, priority_rank ASC, created ASC, id ASC';
		const params: unknown[] = options.type ? [status, options.type, limit, offset] : [status, limit, offset];
		const rows = this.db.prepare(`
			SELECT * FROM jobs WHERE status = ?${typeFilter}
			ORDER BY ${orderBy}
			LIMIT ? OFFSET ?
		`).all(...params);
		return rows.map(mapRow);
	}

	count(status: JobStatus): number {
		const row = this.db.prepare('SELECT COUNT(*) as c FROM jobs WHERE status = ?').get(status);
		return row ? Number(row.c) : 0;
	}

	/** For the intake-button use case (queue-db investigation, Reach-around consumers
	 * table: `intake.ts:77-91` today runs two full `listFolder` passes just to answer
	 * "is anything of this type already active"). */
	countByTypeAndStatus(type: JobType, statuses: JobStatus[]): number {
		if (statuses.length === 0) return 0;
		const placeholders = statuses.map(() => '?').join(', ');
		const row = this.db.prepare(
			`SELECT COUNT(*) as c FROM jobs WHERE type = ? AND status IN (${placeholders})`,
		).get(type, ...statuses);
		return row ? Number(row.c) : 0;
	}

	hasActive(type: JobType): boolean {
		return this.countByTypeAndStatus(type, ['queued', 'running']) > 0;
	}

	/** Dedupe lookup across `queued` + `running` only (item 5). Falsy `dedupeKey`
	 * always returns null without touching the DB — mirrors `insert` storing
	 * empty/falsy keys as NULL, which a `dedupe_key = ''` (or `= NULL`) equality
	 * lookup would never match anyway, but this short-circuits before the query. */
	findActive(dedupeKey: string | null | undefined): DbJobRow | null {
		if (!dedupeKey) return null;
		const row = this.db.prepare(`
			SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running')
			ORDER BY lane_rank ASC, priority_rank ASC, created ASC, id ASC
			LIMIT 1
		`).get(dedupeKey);
		return row ? mapRow(row) : null;
	}

	/**
	 * Dedupe keys of jobs that reached a terminal state at or after `sinceMs` — the
	 * auto-source re-seed suppression set (`Orchestrator.refill`).
	 *
	 * `findActive` deliberately spans `queued`+`running` only, which is right for
	 * dedupe: a settled job must not block a genuine new request. But an auto-source is
	 * not a request — it re-offers the same candidate set on every refill, so without a
	 * settled-recently check a cancelled item comes straight back and the user's Cancel
	 * reads as ignored. This is the durable form of the window `MemoryJobQueue` got from
	 * "refill skips any tracked key" + `sweepTerminal(retentionMs)`; it expires on its
	 * own, so the source may legitimately offer the item again later.
	 */
	settledDedupeKeysSince(sinceMs: number): Set<string> {
		const rows = this.db.prepare(`
			SELECT DISTINCT dedupe_key FROM jobs
			WHERE dedupe_key IS NOT NULL
				AND status IN ('done', 'failed', 'cancelled')
				AND settled_at IS NOT NULL AND settled_at >= ?
		`).all(sinceMs);
		const keys = new Set<string>();
		for (const row of rows) {
			if (typeof row.dedupe_key === 'string' && row.dedupe_key) keys.add(row.dedupe_key);
		}
		return keys;
	}

	/** Soonest future `defer_until` among still-`queued` rows, or null if none are
	 * deferred — lets a backend schedule a wake timer instead of polling. */
	nextDeferredWakeMs(): number | null {
		const row = this.db.prepare(
			`SELECT MIN(defer_until) as m FROM jobs WHERE status = 'queued' AND defer_until IS NOT NULL`,
		).get();
		const value = row?.m;
		return value != null ? Number(value) : null;
	}

	// ---- Claim / lease --------------------------------------------------------------

	/**
	 * Returns the next eligible `queued` job (claiming it as `running` in the same
	 * call) or null if nothing is claimable. Ordering is
	 * `lane_rank -> priority_rank -> created -> id`, reproducing
	 * `JobStore.listFolder`'s comparator exactly (`src/orchestration/JobStore.ts:125-136`):
	 *
	 *   - lane rank: `LANE_RANK` — `user: 0, background: 1` (`src/orchestration/lanes.ts:3-6`)
	 *   - priority rank: `PRIORITY_RANK` — `high: 0, normal: 1, low: 2` (`src/orchestration/JobStore.ts:17-21`)
	 *   - `created` ascending (mint order; ISO/millisecond string, so lexicographic == chronological)
	 *   - `id` ascending as the final tiebreak (millisecond + monotonic hex — see `newJobId`,
	 *     `src/orchestration/utils/dates.ts`), so same-millisecond mints still claim in mint order.
	 *
	 * Deferred rows (`defer_until > nowMs`) are excluded from eligibility, matching
	 * `FileJobBackend`'s `deferUntil` skip.
	 *
	 * Atomic claim: for each ranked candidate (fetched as a batch, not one at a time,
	 * so the whole operation is a fixed two-query shape rather than N+1) this runs
	 * `UPDATE jobs SET status='running', claimed_at=?, claim_token=? WHERE id=? AND
	 * status='queued'` and checks `changes`. `changes === 0` means something else
	 * already moved that row out of `queued` between the SELECT and this UPDATE — the
	 * "lost race" case (real between two separate `DatabaseSync` connections to the
	 * same on-disk file; this is what makes the file backend's 'Recovered: aborted
	 * claim' class unrepresentable here, since there's no window where a job can be
	 * moved-but-not-yet-claimed). On a lost race, the loop just falls through to the
	 * next-ranked candidate instead of returning null.
	 */
	claimNext(nowMs: number, allowedTypes?: JobType[]): DbJobRow | null {
		const candidates = this.selectClaimCandidates(nowMs, allowedTypes);
		for (const id of candidates) {
			if (this.tryClaim(id, nowMs)) return this.get(id);
		}
		return null;
	}

	/**
	 * Claim one specific queued job by id — the manual per-job Run (`JobBackend.runJob`).
	 * Deliberately ignores `defer_until`: the user is asking for this job *now*, which is
	 * exactly what `FileJobBackend.claimById` does relative to its own `claimNext`
	 * (`src/orchestration/FileJobBackend.ts:300-321`). Uses the same guarded
	 * `UPDATE ... WHERE id=? AND status='queued'` as `claimNext`, so a job a drain
	 * worker already claimed answers null rather than double-running.
	 */
	claimById(id: string, nowMs: number): DbJobRow | null {
		return this.tryClaim(id, nowMs) ? this.get(id) : null;
	}

	private selectClaimCandidates(nowMs: number, allowedTypes?: JobType[]): string[] {
		// An explicit empty `allowedTypes` array means "nothing is currently eligible"
		// (e.g. every service this caller cares about is unhealthy) — distinct from
		// `undefined`, which means "no type restriction". Short-circuit rather than
		// building `IN ()`, which is invalid SQL.
		if (allowedTypes && allowedTypes.length === 0) return [];

		let sql = `
			SELECT id FROM jobs
			WHERE status = 'queued' AND (defer_until IS NULL OR defer_until <= ?)
		`;
		const params: unknown[] = [nowMs];
		if (allowedTypes && allowedTypes.length > 0) {
			sql += ` AND type IN (${allowedTypes.map(() => '?').join(', ')})`;
			params.push(...allowedTypes);
		}
		sql += ' ORDER BY lane_rank ASC, priority_rank ASC, created ASC, id ASC LIMIT ?';
		params.push(SqliteJobStore.CLAIM_CANDIDATE_LIMIT);

		return this.db.prepare(sql).all(...params).map(row => String(row.id));
	}

	private tryClaim(id: string, nowMs: number): boolean {
		const result = this.db.prepare(
			`UPDATE jobs SET status = 'running', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'queued'`,
		).run(nowMs, this.processToken, id);
		return result.changes > 0;
	}

	/**
	 * Crash-mid-run lease sweep. Any `running` row whose `claim_token` doesn't match
	 * this process's token, OR whose `claimed_at + staleMsForType(type) < nowMs`,
	 * flips back to `queued` (claim fields cleared, `error` stamped
	 * `'Recovered: stale claim'`). Token mismatch alone recovers a row regardless of
	 * age — deliberately: this plugin runs single-instance-per-vault, so a
	 * `running` row stamped with a token that isn't the *current* process's token can
	 * only mean the process that claimed it no longer exists (a prior load/crash),
	 * which is unconditionally recoverable. The age check is what catches a hang
	 * *within* the same still-live process (token matches, but the claim has sat past
	 * its type's timeout + the caller's buffer). Per-type stale windows are supplied
	 * by the caller (WP-6/7 wire them to per-type timeout + 30s, per the queue-db
	 * investigation's Durability §2). Returns the count recovered.
	 */
	recoverStale(
		nowMs: number,
		staleMsForType: (type: JobType) => number,
		isProtected?: (id: string, type: JobType) => boolean,
	): number {
		const running = this.db.prepare(`SELECT id, type, claim_token, claimed_at FROM jobs WHERE status = 'running'`).all();
		let recovered = 0;
		for (const row of running) {
			const claimToken = row.claim_token != null ? String(row.claim_token as string) : null;
			const claimedAt = row.claimed_at != null ? Number(row.claimed_at) : 0;
			const type = row.type as JobType;
			// A run this process is still executing is never stale, whatever the clock says
			// — the sweep's premise is "no live timer owns this job", and `isRunning` is the
			// counter-example (`JobBackend.isRunning`'s doc comment; the file-side guard is
			// `Orchestrator.scan`'s `if (this.isRunning(...)) continue`). Without it, a job
			// whose type disables the per-run timeout (`timeoutMs: 0` ⇒ a flat 1h stale
			// window) and legitimately runs longer gets bounced running → queued and then
			// claimed a second time, with both copies writing the same note.
			if (isProtected?.(String(row.id), type)) continue;
			const staleMs = staleMsForType(type);
			const tokenMismatch = claimToken !== this.processToken;
			const ageStale = claimedAt + staleMs < nowMs;
			if (!tokenMismatch && !ageStale) continue;

			const result = this.db.prepare(`
				UPDATE jobs
				SET status = 'queued', claimed_at = NULL, claim_token = NULL, error = ?
				WHERE id = ? AND status = 'running'
			`).run('Recovered: stale claim', String(row.id));
			if (result.changes > 0) recovered += 1;
		}
		return recovered;
	}

	// ---- Promotion / deferral -------------------------------------------------------

	/** Lane/priority upgrade of an existing active job. The decision of *whether* to
	 * promote (and to what) stays with the caller, per item 5 — this is a bare
	 * setter. Omitted fields are left untouched; calling with neither is a no-op
	 * read. */
	promote(id: string, lane?: JobLane, priority?: JobPriority): DbJobRow | null {
		if (lane === undefined && priority === undefined) return this.get(id);
		const sets: string[] = [];
		const params: unknown[] = [];
		if (lane !== undefined) { sets.push('lane = ?'); params.push(lane); }
		if (priority !== undefined) { sets.push('priority = ?'); params.push(priority); }
		params.push(id);
		this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
		return this.get(id);
	}

	/** Mirrors `JobStore.setDeferred`: stamps `progress` + `defer_until`, clears
	 * `error`. `deferUntil` is an epoch-ms timestamp (the DB column, unlike the file
	 * backend's ISO string). */
	setDeferred(id: string, message: string, deferUntil: number): void {
		this.db.prepare('UPDATE jobs SET progress = ?, defer_until = ?, error = NULL WHERE id = ?')
			.run(message, deferUntil, id);
	}

	// ---- Field writers (mirror JobStore's frontmatter setters) ----------------------

	setError(id: string, message: string): void {
		this.db.prepare('UPDATE jobs SET error = ? WHERE id = ?').run(message, id);
	}

	setFailureKind(id: string, kind: 'service' | 'job'): void {
		this.db.prepare('UPDATE jobs SET failure_kind = ? WHERE id = ?').run(kind, id);
	}

	clearError(id: string): void {
		this.db.prepare('UPDATE jobs SET error = NULL, failure_kind = NULL WHERE id = ?').run(id);
	}

	setOutputPaths(id: string, paths: string[]): void {
		this.db.prepare('UPDATE jobs SET output_paths = ? WHERE id = ?').run(JSON.stringify(paths), id);
	}

	setPartial(id: string, partial: boolean): void {
		this.db.prepare('UPDATE jobs SET partial = ? WHERE id = ?').run(partial ? 1 : 0, id);
	}

	setProgress(id: string, message: string): void {
		this.db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(message, id);
	}

	setLane(id: string, lane: JobLane): void {
		this.db.prepare('UPDATE jobs SET lane = ? WHERE id = ?').run(lane, id);
	}

	setPriority(id: string, priority: JobPriority): void {
		this.db.prepare('UPDATE jobs SET priority = ? WHERE id = ?').run(priority, id);
	}

	/**
	 * Append with newline semantics like `JobStore.appendNotes` — but the DB `notes`
	 * column is a plain structured field, not a markdown body with a `## Notes`
	 * heading, so there's no marker to find/insert: each call just joins the new
	 * (trimmed) line onto the existing value with `\n`, or becomes the whole value if
	 * `notes` was empty.
	 */
	appendNotes(id: string, lines: string): void {
		const row = this.get(id);
		if (!row) return;
		const trimmed = lines.trim();
		const next = row.notes.length > 0 ? `${row.notes}\n${trimmed}` : trimmed;
		this.db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(next, id);
	}

	// ---- Transition / bulk ops --------------------------------------------------

	/**
	 * `JobStore.move`-equivalent: changes `status`, optionally applying a field
	 * patch in the same statement. `nowMs` is required rather than read internally
	 * (`Date.now()`) so every time-dependent method on this store takes an explicit
	 * clock, matching `claimNext`/`recoverStale`/`pruneTerminal`/`clearQueued`.
	 *
	 * - Any transition landing somewhere other than `queued` clears `defer_until` —
	 *   mirrors `JobStore.move`'s `if (toStatus !== 'queued') delete fm.deferUntil`
	 *   (`src/orchestration/JobStore.ts:221`).
	 * - A transition INTO a terminal status (`done`/`failed`/`cancelled`) stamps
	 *   `settled_at = nowMs` (what `pruneTerminal` ages against) and clears the claim
	 *   fields — a settled job isn't claimed by anyone.
	 * - A transition INTO `queued` (a manual requeue, distinct from `claimNext`/
	 *   `recoverStale`'s own requeue paths) also clears claim fields and
	 *   `settled_at`, so the row reads identically to a freshly-inserted queued job.
	 */
	transition(id: string, toStatus: JobStatus, nowMs: number, patch?: TransitionPatch): DbJobRow | null {
		const sets: string[] = ['status = ?'];
		const params: unknown[] = [toStatus];

		if (toStatus !== 'queued') sets.push('defer_until = NULL');

		const terminal = toStatus === 'done' || toStatus === 'failed' || toStatus === 'cancelled';
		if (terminal) {
			sets.push('settled_at = ?');
			params.push(nowMs);
			sets.push('claimed_at = NULL', 'claim_token = NULL');
		} else if (toStatus === 'queued') {
			sets.push('claimed_at = NULL', 'claim_token = NULL', 'settled_at = NULL');
		}

		if (patch) {
			if ('error' in patch) { sets.push('error = ?'); params.push(patch.error ?? null); }
			if ('failureKind' in patch) { sets.push('failure_kind = ?'); params.push(patch.failureKind ?? null); }
			if (patch.outputPaths !== undefined) { sets.push('output_paths = ?'); params.push(JSON.stringify(patch.outputPaths)); }
			if (patch.partial !== undefined) { sets.push('partial = ?'); params.push(patch.partial ? 1 : 0); }
			if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes); }
			if ('progress' in patch) { sets.push('progress = ?'); params.push(patch.progress ?? null); }
		}

		params.push(id);
		this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
		return this.get(id);
	}

	/**
	 * Bulk `queued -> cancelled`, one statement (no per-row loop), reusing the exact
	 * `CANCELLED_BEFORE_RUN` text both existing backends use (`src/orchestration/
	 * cancellation.ts:88`) so a job cancelled in bulk from the DB backend reads
	 * identically to one cancelled individually. `char(10)` (SQLite's newline
	 * function, evaluated at query time) joins onto any existing `notes` rather than
	 * overwriting — matches `appendNotes`'s join semantics without a second
	 * read/write per row. Returns the count moved, for the emit-exactly-once bulk-op
	 * contract pinned by `tests/queueControl.test.mjs` (WP-6's concern; this store
	 * just reports the number).
	 *
	 * `type` scopes the clear to one job type, because that is the granularity the
	 * queue exposes: `Orchestrator.clearQueued(type)` clears exactly one type, and a
	 * backend that cleared the whole table would silently retire every OTHER type's
	 * queued work on a per-type "Clear queued" click. Omitted ⇒ every queued row
	 * (what a future all-types caller wants).
	 */
	clearQueued(nowMs: number, type?: JobType): number {
		const result = this.db.prepare(`
			UPDATE jobs
			SET status = 'cancelled',
				settled_at = ?,
				defer_until = NULL,
				claimed_at = NULL,
				claim_token = NULL,
				notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END
			WHERE status = 'queued'${type ? ' AND type = ?' : ''}
		`).run(...(type
			? [nowMs, CANCELLED_BEFORE_RUN, CANCELLED_BEFORE_RUN, type]
			: [nowMs, CANCELLED_BEFORE_RUN, CANCELLED_BEFORE_RUN]));
		return result.changes;
	}

	/**
	 * The single-row form of `clearQueued`: retires ONE queued job into `cancelled`,
	 * with the same `CANCELLED_BEFORE_RUN` note. Guarded on `status = 'queued'` in the
	 * statement itself, so a job a drain worker claimed between the caller's read and
	 * this call answers `false` (⇒ `'not-queued'` at the backend, where `cancelJob`
	 * addresses it instead) rather than being yanked out from under a live run — the
	 * DB equivalent of `FileJobBackend.isRetirable`'s live-path check.
	 */
	cancelQueued(id: string, nowMs: number): boolean {
		const result = this.db.prepare(`
			UPDATE jobs
			SET status = 'cancelled',
				settled_at = ?,
				defer_until = NULL,
				claimed_at = NULL,
				claim_token = NULL,
				notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END
			WHERE id = ? AND status = 'queued'
		`).run(nowMs, CANCELLED_BEFORE_RUN, CANCELLED_BEFORE_RUN, id);
		return result.changes > 0;
	}

	// ---- Bulk repair (WP-7's failedJobRepair db arm) -------------------------------

	/**
	 * Failed rows already classified `failure_kind = 'service'` at settle time
	 * (`DbJobBackend.failEntry` stamps it via the same `classifyFailedJob` the file
	 * backend and this repair tool share), grouped by type — the preview a bulk
	 * requeue shows before executing. Mirrors the file arm's `RequeueBreakdown.byType`.
	 */
	serviceOutageFailedByType(): Record<string, number> {
		const rows = this.db.prepare(
			`SELECT type, COUNT(*) as c FROM jobs WHERE status = 'failed' AND failure_kind = 'service' GROUP BY type`,
		).all();
		const out: Record<string, number> = {};
		for (const row of rows) out[String(row.type)] = Number(row.c);
		return out;
	}

	/**
	 * One UPDATE requeuing every `failed` row already classified `failure_kind =
	 * 'service'` back to `queued`, clearing `error`/`failure_kind`/`defer_until` — the
	 * db arm of `failedJobRepair`'s bulk requeue (queue-db investigation: "one
	 * UPDATE…WHERE requeue" replacing the file backend's per-file yield-every-20 loop).
	 * The classification already happened at settle time (`failEntry`), so this needs
	 * no re-scan of error text — it just selects on the column. Returns the count moved.
	 *
	 * No `nowMs` parameter: unlike `transition`/`clearQueued`, this writes no
	 * timestamp column (`settled_at` is cleared, not stamped — a requeued job is
	 * `queued` again, not newly terminal), so there is nothing here for a caller's
	 * clock to control.
	 */
	requeueServiceOutageFailed(): number {
		const result = this.db.prepare(`
			UPDATE jobs
			SET status = 'queued', error = NULL, failure_kind = NULL, defer_until = NULL,
				claimed_at = NULL, claim_token = NULL, settled_at = NULL
			WHERE status = 'failed' AND failure_kind = 'service'
		`).run();
		return result.changes;
	}

	// ---- Retention ----------------------------------------------------------------

	/**
	 * Deletes `done`/`failed`/`cancelled` rows whose `settled_at` is older than
	 * `retentionDays`. `retentionDays <= 0` (including the default-blank `0`) means
	 * "keep forever" and is a no-op — matches the settings field's documented
	 * semantics (`orchestrationJobRetentionDays`, `src/types.ts`). Returns the count
	 * deleted.
	 */
	pruneTerminal(nowMs: number, retentionDays: number): number {
		if (!(retentionDays > 0)) return 0;
		const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
		const result = this.db.prepare(`
			DELETE FROM jobs
			WHERE status IN ('done', 'failed', 'cancelled') AND settled_at IS NOT NULL AND settled_at < ?
		`).run(cutoff);
		return result.changes;
	}
}

function mintProcessToken(): string {
	// Same pattern as `src/settings/sections/triggers.ts:40-42`: prefer
	// `crypto.randomUUID`, fall back to a timestamp + random-suffix string. This
	// token only needs to be unique per process instance, not cryptographically
	// secure — it's a lease-ownership marker, not a credential.
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `pt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseJsonSafe<T>(raw: unknown, fallback: T, context: string): T {
	if (typeof raw !== 'string' || raw.length === 0) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logWarn(`SqliteJobStore: corrupted JSON in ${context}, using fallback`, err);
		return fallback;
	}
}

function mapRow(row: Record<string, unknown>): DbJobRow {
	const id = String(row.id);
	const priority = (row.priority as JobPriority | null) ?? 'normal';
	const lane = (row.lane as JobLane | null) ?? defaultLaneForPriority(priority);
	return {
		id,
		type: row.type as JobType,
		status: row.status as JobStatus,
		lane,
		priority,
		created: String(row.created),
		params: parseJsonSafe(row.params, {}, `jobs.params (${id})`),
		error: row.error != null ? String(row.error as string) : undefined,
		failureKind: row.failure_kind === 'service' || row.failure_kind === 'job' ? row.failure_kind : undefined,
		deferUntil: row.defer_until != null ? Number(row.defer_until) : undefined,
		progress: row.progress != null ? String(row.progress as string) : undefined,
		outputPaths: parseJsonSafe(row.output_paths, [], `jobs.output_paths (${id})`),
		partial: Number(row.partial) === 1,
		notes: row.notes != null ? String(row.notes as string) : '',
		claimedAt: row.claimed_at != null ? Number(row.claimed_at) : undefined,
		claimToken: row.claim_token != null ? String(row.claim_token as string) : undefined,
		settledAt: row.settled_at != null ? Number(row.settled_at) : undefined,
		dedupeKey: row.dedupe_key != null ? String(row.dedupe_key as string) : undefined,
	};
}
