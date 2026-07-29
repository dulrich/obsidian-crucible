// The repo's first "flicker gate" pattern. The Ingestion dashboard's sections all
// re-render by tearing down and rebuilding their DOM (renderSortableTable's
// `parent.empty()`, renderQueueMonitor's `body.empty()`, ...), which during a queue
// drain happens up to ~4x/sec and visibly jumps: scroll position and focus are lost
// every time. `refreshWithScrollPreserved` generalizes the one existing
// scroll-preserving idiom in the repo — `CrucibleSettingTab.refreshDisplay`
// (src/settings.ts:83-88: save scrollTop, re-render, restore in rAF) — so any
// teardown/rebuild render path can opt in without duplicating it. Kept small and
// dependency-free (no DOM classes referenced at runtime, only duck-typed shapes) so
// it stays portable and is meant to be copied by future flicker-gate call sites, not
// grown into a framework.

/**
 * Wraps a render callback that tears down and rebuilds `region`'s contents so the
 * rebuild doesn't visibly jump:
 *  - the scroll position of `region`'s nearest actually-scrolling ancestor is
 *    captured and restored via the shared coordinator below, because all 13
 *    ingestion-dashboard sections share ONE scroller (the workspace leaf's
 *    `.view-content`) — see the coordinator's own comment for why a per-call
 *    capture/restore is wrong under concurrency;
 *  - if focus currently sits inside `region`, a best-effort equivalent element is
 *    re-focused after the rebuild. This stays per-region and per-call (not
 *    coordinated) — unlike scroll position, focus is a property of `region`
 *    itself, not of the shared scroller, so there is nothing to merge across
 *    concurrent calls.
 *
 * `render` is expected to be the section's existing full-rebuild render function —
 * this does not diff or avoid the rebuild, only hide its visual side effects.
 */
export async function refreshWithScrollPreserved(
	region: HTMLElement,
	render: () => void | Promise<void>,
): Promise<void> {
	const scrollEl = findScrollAncestor(region);
	const coordinator = scrollEl ? acquireScrollCoordinator(scrollEl) : null;
	if (coordinator && scrollEl) {
		// 0 -> 1: the first concurrent refresh in this burst captures, before ANY
		// of the concurrent renders has started tearing anything down.
		if (coordinator.count === 0) coordinator.scrollTop = scrollEl.scrollTop;
		coordinator.count++;
	}
	const focusToken = captureFocus(region);

	try {
		await render();
	} finally {
		if (coordinator && scrollEl) {
			coordinator.count--;
			// Guard against underflow rather than assume every acquire is perfectly
			// paired with a release (a render() that throws still reaches here via
			// `finally`, but a defensive floor costs nothing and prevents a stuck
			// negative count from silently disabling restore for the rest of the
			// session).
			if (coordinator.count <= 0) {
				coordinator.count = 0;
				restoreScrollTop(scrollEl, coordinator.scrollTop);
			}
		}
	}

	requestAnimationFrame(() => {
		restoreFocus(region, focusToken);
	});
}

// --- Dashboard-level scroll coordinator ---
//
// All 13 ingestion-dashboard sections render into the same scrolling ancestor
// (`.crucible-ingestion-dashboard` sits directly in the view's `.view-content`;
// neither the section nor its body element establishes its own overflow — see
// AGENTS.md). A per-call capture/restore (the original shape of this function) is
// wrong once more than one section refreshes concurrently, which is the normal
// case during a queue drain: section A's teardown can transiently shrink the
// shared scroller's content while section B's capture reads `scrollTop`, so B
// captures an already-clamped value (the capture-time clamp); and if A's rebuild
// hasn't finished growing the content back by the time B's render() resolves and
// assigns `scrollTop`, the shared scroller clamps the assignment right back down
// (the restore-time clamp) even though B captured the correct value. Keying a
// shared counter + captured value on the scroll element itself — rather than one
// per `refreshWithScrollPreserved` call — fixes both: capture only happens on the
// transition from 0 in-flight refreshes to 1 (before any of the concurrent
// renders has started), and restore only happens on the transition back to 0
// (after every concurrent render has settled).
interface ScrollCoordinatorState {
	count: number;
	scrollTop: number;
}

const scrollCoordinators = new WeakMap<HTMLElement, ScrollCoordinatorState>();

function acquireScrollCoordinator(scrollEl: HTMLElement): ScrollCoordinatorState {
	let state = scrollCoordinators.get(scrollEl);
	if (!state) {
		state = { count: 0, scrollTop: 0 };
		scrollCoordinators.set(scrollEl, state);
	}
	return state;
}

// Restores `scrollEl.scrollTop` after a DOUBLE rAF — the rebuilt content needs a
// full layout pass before an assignment sticks (same reasoning as the original
// single-rAF restore), and the second frame gives a sibling section's own
// still-in-flight rebuild one more frame to finish growing the scroller back to
// its full height before the assignment lands. After that, it reads back once: if
// a still-settling sibling clamped the assignment anyway, one more rAF re-asserts
// it. This is a single extra attempt, not a retry loop — a value still wrong after
// a third frame reflects a real content change (the prior scroll position no
// longer exists), not a transient clamp, and re-asserting forever would fight the
// user's own subsequent scrolling.
function restoreScrollTop(scrollEl: HTMLElement, target: number): void {
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			scrollEl.scrollTop = target;
			requestAnimationFrame(() => {
				if (scrollEl.scrollTop !== target) scrollEl.scrollTop = target;
			});
		});
	});
}

// Walks up from `region` (inclusive) to find the nearest ancestor that is both
// styled to scroll (overflow-y auto/scroll) and currently overflowing. Measuring
// rather than matching a fixed selector (contrast the settings idiom's
// `.vertical-tab-content, .crucible-settings-host`) is what makes this reusable
// outside settings: the ingestion dashboard's actual scroller is whatever hosts its
// view (a workspace leaf's `.view-content` today, styled by Obsidian core, not by
// this plugin), and a fixed selector would silently stop working the moment that
// host changes.
function findScrollAncestor(region: HTMLElement): HTMLElement | null {
	let node: HTMLElement | null = region;
	while (node) {
		const view = node.ownerDocument?.defaultView;
		const overflowY = view?.getComputedStyle(node).overflowY;
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

interface FocusToken {
	tag: string;
	className: string;
	text: string;
	// Which occurrence of (tag, className, text) this was among region's matches at
	// capture time — the closest thing rebuilt DOM (no ids) has to a stable key.
	ordinal: number;
}

function isElementLike(node: unknown): node is HTMLElement {
	return !!node && typeof (node as HTMLElement).tagName === 'string';
}

function textOf(el: HTMLElement): string {
	return (el.textContent ?? '').trim().slice(0, 80);
}

function matchesIn(region: HTMLElement, tag: string, className: string, text: string): HTMLElement[] {
	return Array.from(region.querySelectorAll<HTMLElement>(tag.toLowerCase()))
		.filter(n => n.className === className && textOf(n) === text);
}

// Best-effort focus fingerprint: tag + class + trimmed text content, plus which
// occurrence of that fingerprint it was among matches within `region`. A rebuilt
// table has no other stable identity for its cells and buttons (sortable-table
// headers and per-row action buttons are literally recreated every render), but the
// same fingerprint almost always lands on the semantically-equivalent element after
// rebuild — e.g. the same-named sortable column header, or the Cancel button for the
// row a user was just interacting with (if that row still exists post-rebuild).
function captureFocus(region: HTMLElement): FocusToken | null {
	const active = region.ownerDocument?.activeElement;
	if (!isElementLike(active) || !region.contains(active)) return null;
	const tag = active.tagName;
	const className = active.className;
	const text = textOf(active);
	const ordinal = matchesIn(region, tag, className, text).indexOf(active);
	return { tag, className, text, ordinal: ordinal < 0 ? 0 : ordinal };
}

function restoreFocus(region: HTMLElement, token: FocusToken | null): void {
	if (!token) return;
	const doc = region.ownerDocument;
	// Something else already claimed focus during the render (e.g. the user clicked
	// elsewhere) — don't steal it back.
	if (doc && doc.activeElement && doc.activeElement !== doc.body) return;
	const candidate = matchesIn(region, token.tag, token.className, token.text)[token.ordinal];
	candidate?.focus();
}

// --- Cadence gate ---

/**
 * Wraps `fn` so repeated calls collapse to at most one invocation per `intervalMs`,
 * with a guaranteed trailing call so the final state of a burst always renders. This
 * is cadence, not debouncing or diffing: a call arriving >= intervalMs after the last
 * run fires immediately (so a lone event still renders right away); calls arriving
 * inside the window are coalesced into a single call scheduled for the window's end,
 * which always reflects whatever state `fn` reads when it actually runs.
 */
export function minIntervalGate(fn: () => void | Promise<void>, intervalMs: number): () => void {
	// `null`, not 0, marks "never run" — Date.now() can itself be 0 (fake timers in
	// tests start there by default), so a numeric sentinel would misfire on the very
	// first call.
	let lastRun: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending = false;

	const run = () => {
		lastRun = Date.now();
		pending = false;
		void fn();
	};

	return () => {
		const elapsed = lastRun === null ? Infinity : Date.now() - lastRun;
		if (elapsed >= intervalMs && !timer) {
			run();
			return;
		}
		pending = true;
		if (timer) return; // a trailing call is already scheduled for this window
		timer = setTimeout(() => {
			timer = null;
			if (pending) run();
		}, Math.max(intervalMs - elapsed, 0));
	};
}
