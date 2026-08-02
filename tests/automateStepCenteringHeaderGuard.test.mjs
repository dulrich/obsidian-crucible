// WP-DP4: with the settings tab strip now pinned in a sticky header
// (`.crucible-settings-sticky-header`, src/settings.ts), the Add-step scroll-to-center
// math in automate.ts must center a newly inserted step within the visible region BELOW
// the header, not the raw scroller viewport — otherwise the header covers the top of the
// "centered" step. The header height must be measured live (its rendered offsetHeight),
// never a hardcoded pixel constant, since it can vary (e.g. localization, font size). A
// source-text pin is the right tool here (same rationale as
// tests/ingestionDashboardLayoutReadyGuard.test.mjs) — this is a formula shape, not a
// runtime state transition that's practical to unit-test without a full DOM layout engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/settings/sections/automate.ts', 'utf8');

test('STRUCTURAL: the Add-step centering math measures the sticky header live and folds it into the target scrollTop', () => {
	const addStepIdx = src.indexOf("actionRow.addButton(bt => bt.setButtonText('Add step')");
	assert.ok(addStepIdx >= 0, 'Add step button handler not found');
	const block = src.slice(addStepIdx, addStepIdx + 1200);

	assert.ok(
		block.includes("querySelector<HTMLElement>('.crucible-settings-sticky-header')"),
		'expected the centering handler to look up the sticky header element live',
	);
	assert.ok(
		/headerHeight\s*=\s*headerEl\?\.offsetHeight\s*\?\?\s*0/.test(block),
		'expected header height to be read from the live element (offsetHeight), not a hardcoded constant',
	);
	assert.ok(
		!/\b\d{2,}\s*\/\/.*header/i.test(block) && !/headerHeight\s*=\s*\d/.test(block),
		'header height must not be hardcoded as a numeric pixel constant',
	);
	assert.ok(
		/scrollEl\.scrollTop\s*=\s*stepCenter\s*-\s*\(scrollEl\.clientHeight\s*\+\s*headerHeight\)\s*\/\s*2/.test(block),
		'expected the scrollTop formula to subtract the header height from the centering math (center on the region below the pinned header)',
	);
});
