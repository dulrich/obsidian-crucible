import { logWarn } from '../../log';
import type { SqliteDatabase, SqliteStatement } from './types';

/**
 * One link-registry record (link-registry-out-of-vault WP-1) — the fields
 * `applyLinkToRegistry` used to write as link-record note frontmatter, camelCased.
 * `sourceNotes` holds `[[path-without-.md]]` wikilinks, the same representation the
 * frontmatter carried, so legacy-imported and newly written records resolve alike.
 * `trackedSource` is `false`, `'candidate'`, or any later decision value.
 */
export interface LinkRecord {
	canonicalUrl: string;
	url: string;
	domain: string;
	sourceNotes: string[];
	firstSeen: string | null;
	lastSeen: string | null;
	state: string;
	discoveryMethod: string;
	trackedSource: unknown;
	trackedSourceType: string | null;
	trackedSourceNote: string | null;
	referredMaterial: string | null;
	decisionReason: string | null;
	ytVideoId: string | null;
	xStatusId: string | null;
}

/**
 * An incoming observation to merge. Only `canonicalUrl`/`url` are required; every
 * other field is merged against the stored row (see `mergeLinkRecord`). `firstSeen`/
 * `lastSeen` are explicit — the merge never assumes the incoming record is "now", so
 * WP-2's legacy importer can feed historical dates through the same path.
 */
export interface LinkRecordInput {
	canonicalUrl: string;
	url: string;
	domain?: string;
	sourceNotes?: Iterable<string>;
	firstSeen?: string | null;
	lastSeen?: string | null;
	state?: string | null;
	discoveryMethod?: string | null;
	/** A truthy value other than `false` escalates a stored `false`/missing value
	 * (only that — a stored decision is never overwritten). The live writers pass
	 * `'candidate'`. */
	trackedSource?: unknown;
	trackedSourceType?: string | null;
	trackedSourceNote?: string | null;
	referredMaterial?: string | null;
	decisionReason?: string | null;
	ytVideoId?: string | null;
	xStatusId?: string | null;
}

export interface LinkRecordUpsertResult {
	created: boolean;
	/** The record's tracked_source was set from `false`/missing by this upsert. */
	candidateFlagged: boolean;
	/** False when the merged record equals the stored row — no write happened. */
	changed: boolean;
}

const COLUMNS = [
	'canonical_url', 'url', 'domain', 'source_notes', 'first_seen', 'last_seen', 'state',
	'discovery_method', 'tracked_source', 'tracked_source_type', 'tracked_source_note',
	'referred_material', 'decision_reason', 'yt_video_id', 'x_status_id',
] as const;

/**
 * The `link_records` table's store, over the SAME `SqliteDatabase` handle the job
 * queue uses (`Orchestrator.linkRegistry()` builds it from `SqliteJobStore.database`
 * — never a second connection). Same shape as `SqliteJobStore`: the handle is
 * injected, statements are prepared once, corrupt JSON degrades via `logWarn`.
 */
export class LinkRegistryStore {
	private readonly selectOne: SqliteStatement;
	private readonly insertRow: SqliteStatement;
	private readonly updateRow: SqliteStatement;
	private readonly selectWithX: SqliteStatement;
	private readonly selectAll: SqliteStatement;
	private readonly countRows: SqliteStatement;

	constructor(private readonly db: SqliteDatabase) {
		this.selectOne = db.prepare('SELECT * FROM link_records WHERE canonical_url = ?');
		this.insertRow = db.prepare(
			`INSERT INTO link_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
		);
		this.updateRow = db.prepare(
			`UPDATE link_records SET ${COLUMNS.slice(1).map(c => `${c} = ?`).join(', ')} WHERE canonical_url = ?`,
		);
		this.selectWithX = db.prepare(
			"SELECT * FROM link_records WHERE x_status_id IS NOT NULL AND x_status_id != '' ORDER BY canonical_url",
		);
		this.selectAll = db.prepare('SELECT * FROM link_records ORDER BY canonical_url');
		this.countRows = db.prepare('SELECT COUNT(*) AS n FROM link_records');
	}

	get(canonicalUrl: string): LinkRecord | null {
		const row = this.selectOne.get(canonicalUrl);
		return row ? mapRow(row) : null;
	}

	/** Every record carrying an X status id (index-backed) — XBackfill + the X-posts
	 * dashboard section. */
	listWithXStatus(): LinkRecord[] {
		return this.selectWithX.all().map(mapRow);
	}

	listAll(): LinkRecord[] {
		return this.selectAll.all().map(mapRow);
	}

	count(): number {
		const row = this.countRows.get();
		return Number(row?.n ?? 0);
	}

	/** Create-or-merge. An upsert whose merged record equals the stored row performs
	 * no write and reports `changed: false`. */
	upsert(input: LinkRecordInput): LinkRecordUpsertResult {
		const existing = this.get(input.canonicalUrl);
		const { record, candidateFlagged } = mergeLinkRecord(existing, input);
		if (!existing) {
			this.insertRow.run(...toParams(record));
			return { created: true, candidateFlagged, changed: true };
		}
		const next = toParams(record);
		const prev = toParams(existing);
		if (next.every((v, i) => v === prev[i])) return { created: false, candidateFlagged: false, changed: false };
		this.updateRow.run(...next.slice(1), record.canonicalUrl);
		return { created: false, candidateFlagged, changed: true };
	}
}

function nonEmpty(v: unknown): v is string {
	return typeof v === 'string' && v.trim() !== '';
}

/** Valid `YYYY-MM-DD…` date-ish strings compare lexically; anything else is "no
 * value" so a garbage stored date can never win min/max. */
function validDate(v: unknown): string | null {
	return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null;
}

function pickDate(a: unknown, b: unknown, want: 'min' | 'max'): string | null {
	const x = validDate(a);
	const y = validDate(b);
	if (!x) return y;
	if (!y) return x;
	if (want === 'min') return x <= y ? x : y;
	return x >= y ? x : y;
}

function unionSourceNotes(existing: readonly string[], additions: Iterable<string> | undefined): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (v: unknown): void => {
		if (typeof v === 'string' && v.trim() && !seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	};
	for (const v of existing) add(v);
	if (additions) for (const v of additions) add(v);
	return out;
}

function isUnflagged(v: unknown): boolean {
	return v === false || v === undefined || v === null;
}

/**
 * The merge semantics of the former frontmatter writer, made order-independent so a
 * reconciling importer can reuse them: source notes union (stored order first);
 * `firstSeen` earliest valid, `lastSeen` latest valid; `state`/`discoveryMethod` and
 * the nullable decision fields keep a stored non-empty value; `trackedSource` only
 * escalates `false`/missing → incoming; yt/x ids only fill empty. url/domain follow
 * the incoming observation (as the frontmatter writer did).
 */
export function mergeLinkRecord(
	existing: LinkRecord | null,
	input: LinkRecordInput,
): { record: LinkRecord; candidateFlagged: boolean } {
	const base: LinkRecord = existing ?? {
		canonicalUrl: input.canonicalUrl,
		url: input.url,
		domain: input.domain ?? '',
		sourceNotes: [],
		firstSeen: null,
		lastSeen: null,
		state: '',
		discoveryMethod: '',
		trackedSource: false,
		trackedSourceType: null,
		trackedSourceNote: null,
		referredMaterial: null,
		decisionReason: null,
		ytVideoId: null,
		xStatusId: null,
	};
	const keep = (stored: string | null, incoming: string | null | undefined): string | null =>
		nonEmpty(stored) ? stored : (nonEmpty(incoming) ? incoming : null);

	let candidateFlagged = false;
	let trackedSource = base.trackedSource;
	let trackedSourceType = base.trackedSourceType;
	if (!isUnflagged(input.trackedSource) && isUnflagged(base.trackedSource)) {
		trackedSource = input.trackedSource;
		trackedSourceType = nonEmpty(input.trackedSourceType) ? input.trackedSourceType : null;
		candidateFlagged = true;
	}
	if (isUnflagged(trackedSource)) trackedSource = false;

	const record: LinkRecord = {
		canonicalUrl: base.canonicalUrl,
		url: nonEmpty(input.url) ? input.url : base.url,
		domain: nonEmpty(input.domain) ? input.domain : base.domain,
		sourceNotes: unionSourceNotes(base.sourceNotes, input.sourceNotes),
		firstSeen: pickDate(base.firstSeen, input.firstSeen, 'min'),
		lastSeen: pickDate(base.lastSeen, input.lastSeen, 'max'),
		state: keep(base.state, input.state) ?? 'pending',
		discoveryMethod: keep(base.discoveryMethod, input.discoveryMethod) ?? 'scan',
		trackedSource,
		trackedSourceType,
		trackedSourceNote: keep(base.trackedSourceNote, input.trackedSourceNote),
		referredMaterial: keep(base.referredMaterial, input.referredMaterial),
		decisionReason: keep(base.decisionReason, input.decisionReason),
		ytVideoId: keep(base.ytVideoId, input.ytVideoId),
		xStatusId: keep(base.xStatusId, input.xStatusId),
	};
	return { record, candidateFlagged };
}

function toParams(r: LinkRecord): (string | null)[] {
	return [
		r.canonicalUrl, r.url, r.domain, JSON.stringify(r.sourceNotes), r.firstSeen, r.lastSeen,
		r.state, r.discoveryMethod, JSON.stringify(r.trackedSource ?? false), r.trackedSourceType,
		r.trackedSourceNote, r.referredMaterial, r.decisionReason, r.ytVideoId, r.xStatusId,
	];
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function parseJsonSafe<T>(raw: unknown, fallback: T, context: string): T {
	if (typeof raw !== 'string') return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		logWarn(`LinkRegistryStore: corrupted JSON in ${context}, using fallback`, err);
		return fallback;
	}
}

function mapRow(row: Record<string, unknown>): LinkRecord {
	const canonicalUrl = String(row.canonical_url);
	const notes = parseJsonSafe<unknown>(row.source_notes, [], `source_notes of ${canonicalUrl}`);
	return {
		canonicalUrl,
		url: str(row.url) ?? '',
		domain: str(row.domain) ?? '',
		sourceNotes: Array.isArray(notes) ? notes.filter((v): v is string => typeof v === 'string') : [],
		firstSeen: str(row.first_seen),
		lastSeen: str(row.last_seen),
		state: str(row.state) ?? 'pending',
		discoveryMethod: str(row.discovery_method) ?? 'scan',
		trackedSource: parseJsonSafe<unknown>(row.tracked_source, false, `tracked_source of ${canonicalUrl}`),
		trackedSourceType: str(row.tracked_source_type),
		trackedSourceNote: str(row.tracked_source_note),
		referredMaterial: str(row.referred_material),
		decisionReason: str(row.decision_reason),
		ytVideoId: str(row.yt_video_id),
		xStatusId: str(row.x_status_id),
	};
}
