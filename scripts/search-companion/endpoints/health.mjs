import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { json } from '../http.mjs';
import { SCHEMA_VERSION, SERVICE_VERSION } from '../schema.mjs';

// GET /health — the client's availability probe and the schema-pairing check.
//
// Injected dependencies: the vector backend, the handler-scoped `state` holder (WP-2: flush
// activity and the recent-search window), the process start stamp, and the cgroup root (a
// test points it at a fixture directory). No database handle, no body read (this is the one
// route that never calls readJson), which is what keeps a probe cheap enough to fire on a
// timer. WP-2 keeps it that way: `vectors.stats()` above the inline limit answers from cache or
// schedules — never a full scan here — and the cgroup reads are six tiny pseudo-files.
export function createHealthEndpoint({ vectors, state = {}, startedAt = null, cgroupRoot = '/sys/fs/cgroup' }) {
	const memoryReader = createCgroupMemoryReader(cgroupRoot);
	return (req, res) => {
		// Computed, not a literal: `vectorAvailable` is "this index actually holds
		// vectors the scan can use", across every vault in the database.
		const stats = vectors.stats();
		const body = {
			ok: true,
			version: SERVICE_VERSION,
			schemaVersion: SCHEMA_VERSION,
			vectorAvailable: stats.count > 0 && Boolean(stats.dim),
			vectorBackend: vectors.name,
			embeddedChunks: stats.count,
			embeddingDim: stats.dim,
			embeddingModel: stats.model,
			// Distinct spaces across every vault, so a mixed index is *visible* here
			// rather than inferred from searches that quietly went keyword-only. More
			// than one entry — or any unattributed vectors alongside attributed ones —
			// means some search will degrade; see resolveScanSpace.
			embeddingSpaces: stats.spaces ?? [],
			embeddingSpace: (stats.spaces ?? []).length === 1 && !stats.unlabelledCount ? stats.spaces[0] : null,
			unattributedEmbeddedChunks: stats.unlabelledCount ?? 0,
			// ── WP-2 additive, stateful fields ──
			startedAt,
			vector: { status: typeof vectors.status === 'function' ? vectors.status().vector : 'absent' },
			indexing: {
				flushActive: Boolean(state.flushActive),
				lastFlushMs: typeof state.lastFlushMs === 'number' ? state.lastFlushMs : null,
			},
			recentSearch: summarizeRecentSearches(state.recentSearches),
		};
		const memory = memoryReader();
		if (memory) body.memory = memory;
		return json(res, 200, body);
	};
}

export function summarizeRecentSearches(entries) {
	const list = Array.isArray(entries) ? entries : [];
	if (list.length === 0) return { count: 0, p50Ms: null, p90Ms: null, maxMs: null, degraded: 0 };
	const sorted = list.map(entry => Number(entry.ms) || 0).sort((a, b) => a - b);
	const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return {
		count: list.length,
		p50Ms: at(0.5),
		p90Ms: at(0.9),
		maxMs: sorted[sorted.length - 1],
		degraded: list.filter(entry => entry.degraded).length,
	};
}

// Parses cgroup v2 memory files into the health shape. Pure: `files` maps file name → raw text
// (missing/unreadable → undefined). `previousMaxEvents` is the `max` event count seen on the
// previous health read (null on the first). Returns null when memory.current is unreadable
// (not in a cgroup v2 container — e.g. a bare `node` run on a host without the files).
//
// The pressure rule is Command Center's, kept identical on purpose:
//   exhausted = max events rose since the previous read, OR swap in use with
//               current + swap >= 95% of the limit;
//   pressure  = max events > 0, OR peak >= limit, OR (current - inactive_file + swap) >= 90%
//               of the limit;
//   swap alone is NOT pressure.
export function parseCgroupMemory(files, previousMaxEvents = null) {
	const num = text => {
		if (typeof text !== 'string') return null;
		const trimmed = text.trim();
		if (trimmed === '' || trimmed === 'max') return null;
		const value = Number(trimmed);
		return Number.isFinite(value) ? value : null;
	};
	const keyed = (text, key) => {
		if (typeof text !== 'string') return null;
		for (const line of text.split('\n')) {
			const [name, value] = line.trim().split(/\s+/);
			if (name === key) return num(value);
		}
		return null;
	};
	const currentBytes = num(files['memory.current']);
	if (currentBytes === null) return null;
	const limitBytes = num(files['memory.max']);
	const swapBytes = num(files['memory.swap.current']) ?? 0;
	const peakBytes = num(files['memory.peak']);
	const maxEvents = keyed(files['memory.events'], 'max') ?? 0;
	const inactiveFile = keyed(files['memory.stat'], 'inactive_file') ?? 0;
	let pressure = 'ok';
	const rose = previousMaxEvents !== null && maxEvents > previousMaxEvents;
	if (rose || (limitBytes !== null && swapBytes > 0 && currentBytes + swapBytes >= 0.95 * limitBytes)) {
		pressure = 'exhausted';
	} else if (
		maxEvents > 0
		|| (limitBytes !== null && peakBytes !== null && peakBytes >= limitBytes)
		|| (limitBytes !== null && currentBytes - inactiveFile + swapBytes >= 0.9 * limitBytes)
	) {
		pressure = 'pressure';
	}
	return { limitBytes, currentBytes, swapBytes, peakBytes, maxEvents, pressure };
}

const CGROUP_FILES = ['memory.current', 'memory.swap.current', 'memory.peak', 'memory.max', 'memory.events', 'memory.stat'];

export function createCgroupMemoryReader(root) {
	let previousMaxEvents = null;
	return () => {
		const files = {};
		for (const name of CGROUP_FILES) {
			try {
				files[name] = readFileSync(join(root, name), 'utf8');
			} catch {
				files[name] = undefined;
			}
		}
		const memory = parseCgroupMemory(files, previousMaxEvents);
		if (memory) previousMaxEvents = memory.maxEvents;
		return memory;
	};
}
