// Covers WP-DP2: ingestion section header/layout polish.
//
// (a) Refresh/Auto-enqueue vertical alignment — `.crucible-ingestion-section-header`
// is `display: flex; align-items: baseline` (styles.css), and the Auto-enqueue
// toggle's `<label>` (src/ingestion/sections/uncapturedVideos.ts) has a checkbox as
// its first flex item. A checkbox has no text baseline, so the flex algorithm falls
// back to the item's bottom margin edge as its baseline, making the label ride
// high/low relative to the Refresh button and h3. The fix mirrors the existing
// `.crucible-ingestion-section-toggle` precedent: `align-self: center` on
// `.crucible-ingestion-header-toggle`, pinned here as source text since there is no
// live UI/layout engine in this test environment.
//
// (b) `xPosts` is the ONLY intake-style section that previously omitted
// `defaultCollapsed: true` from its `buildSection(...)` call — pinned so it can't
// silently regress back to expanded-by-default.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardSrc = readFileSync('src/ingestionDashboard.ts', 'utf8');
const stylesSrc = readFileSync('styles.css', 'utf8');

test('STRUCTURAL: .crucible-ingestion-header-toggle carries align-self: center', () => {
	const ruleIdx = stylesSrc.indexOf('.crucible-ingestion-header-toggle {');
	assert.ok(ruleIdx >= 0, '.crucible-ingestion-header-toggle rule not found in styles.css');
	const closeIdx = stylesSrc.indexOf('}', ruleIdx);
	const rule = stylesSrc.slice(ruleIdx, closeIdx);
	assert.match(rule, /align-self:\s*center;/, '.crucible-ingestion-header-toggle must set align-self: center to fix baseline drift against a checkbox-first label');
});

test('STRUCTURAL: xPosts section registers with defaultCollapsed: true', () => {
	const callIdx = dashboardSrc.indexOf("'xPosts',\n\t\t\t'X posts',");
	assert.ok(callIdx >= 0, 'xPosts buildSection call site not found');
	const nextCallIdx = dashboardSrc.indexOf('this.registerListeners();', callIdx);
	assert.ok(nextCallIdx >= 0, 'could not bound the xPosts buildSection call');
	const callBody = dashboardSrc.slice(callIdx, nextCallIdx);
	// The call site is `this.buildSection('xPosts', 'X posts', <desc>, <decorateHeader>, true);`
	// — assert the trailing `true` default-collapsed argument is present before the
	// call closes, and that it isn't accidentally shared with the next call.
	const closeParenIdx = callBody.indexOf(');');
	const args = callBody.slice(0, closeParenIdx);
	assert.match(args, /,\s*true\s*,?\s*$/, `expected xPosts buildSection call to end with a trailing "true" (defaultCollapsed) argument, got: ${JSON.stringify(args)}`);
});
