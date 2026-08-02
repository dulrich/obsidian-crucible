// WP-DP4: the settings tab strip (`.crucible-tab-nav`) + rule (`.crucible-tab-hr`) are
// wrapped in a sticky header container (`.crucible-settings-sticky-header`) so both stay
// pinned while a long tab (e.g. Automate with many chains) scrolls underneath. The focus
// trap button is a keyboard affordance, not header chrome, so it must stay OUTSIDE/BEFORE
// the wrap. `display()` is called on every tab switch/re-render and `containerEl.empty()`s
// first, so DOM ordering is markup here, not a runtime state transition — a source-text pin
// (in the style of tests/ingestionDashboardLayoutReadyGuard.test.mjs) is the right tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/settings.ts', 'utf8');

test('STRUCTURAL: the focus trap is created before the sticky header wrap', () => {
	const focusTrapIdx = src.indexOf("containerEl.createEl('button', { cls: 'crucible-focus-trap' });");
	const stickyHeaderIdx = src.indexOf("containerEl.createDiv({ cls: 'crucible-settings-sticky-header' });");
	assert.ok(focusTrapIdx >= 0, 'focus trap creation not found');
	assert.ok(stickyHeaderIdx >= 0, 'sticky header wrap creation not found');
	assert.ok(focusTrapIdx < stickyHeaderIdx, 'focus trap must be created before (outside) the sticky header wrap');
});

test('STRUCTURAL: the tab nav is created as a child of the sticky header wrap, not containerEl directly', () => {
	assert.ok(
		src.includes("const stickyHeader = containerEl.createDiv({ cls: 'crucible-settings-sticky-header' });\n\t\tconst navBar = stickyHeader.createDiv({ cls: 'crucible-tab-nav' });"),
		'expected navBar to be created via stickyHeader.createDiv, immediately after the stickyHeader is created',
	);
});

test('STRUCTURAL: the tab-strip rule is appended to the sticky header wrap, not containerEl directly', () => {
	assert.ok(
		src.includes("stickyHeader.createEl('hr', { cls: 'crucible-tab-hr' });"),
		'expected the .crucible-tab-hr rule to be created via stickyHeader.createEl',
	);
	assert.ok(
		!src.includes("containerEl.createEl('hr', { cls: 'crucible-tab-hr' });"),
		'the .crucible-tab-hr rule must no longer be created directly on containerEl',
	);
});

test('STRUCTURAL: both the tab-row and detail-editor Back-bar branches render into the wrapped navBar', () => {
	const stickyHeaderIdx = src.indexOf("const stickyHeader = containerEl.createDiv({ cls: 'crucible-settings-sticky-header' });");
	const navBarIdx = src.indexOf("const navBar = stickyHeader.createDiv({ cls: 'crucible-tab-nav' });");
	const isEditingDetailIdx = src.indexOf('if (this.isEditingDetail())', navBarIdx);
	const backBtnIdx = src.indexOf("navBar.createDiv({ cls: 'crucible-tab-btn' });", isEditingDetailIdx);
	const createTabIdx = src.indexOf('const createTab =', isEditingDetailIdx);

	assert.ok(stickyHeaderIdx >= 0 && navBarIdx >= 0, 'sticky header / navBar setup not found');
	assert.ok(stickyHeaderIdx < navBarIdx, 'stickyHeader must be created before navBar');
	assert.ok(isEditingDetailIdx >= 0, 'isEditingDetail() branch not found after navBar creation');
	assert.ok(backBtnIdx >= 0, 'Back button must still be created on navBar (the wrapped element)');
	assert.ok(createTabIdx >= 0, 'createTab helper (tab-row branch) must still target navBar');
});

// WP-F1: the wrapper's negative-margin/padding compensation used to hardcode 16px/24px,
// but the actual scroll parent's padding varies at runtime (workspace tab vs. native
// modal), leaving an unpainted band. `applyStickyHeaderPadding` measures the real scroll
// parent at mount and mirrors its padding onto custom properties styles.css consumes.
test('STRUCTURAL: the sticky header padding is measured at mount, not hardcoded', () => {
	const navBarIdx = src.indexOf("const navBar = stickyHeader.createDiv({ cls: 'crucible-tab-nav' });");
	assert.ok(navBarIdx >= 0, 'navBar setup not found');
	assert.ok(
		src.indexOf('applyStickyHeaderPadding(stickyHeader);', navBarIdx) >= 0,
		'expected applyStickyHeaderPadding(stickyHeader) to run after the pinned stickyHeader/navBar lines',
	);
	assert.ok(
		src.includes("stickyHeader.style.setProperty('--crucible-sticky-pad-top'"),
		'expected applyStickyHeaderPadding to set --crucible-sticky-pad-top on the wrapper',
	);
});

test('STRUCTURAL: styles.css consumes the measured padding custom properties', () => {
	const css = readFileSync('styles.css', 'utf8');
	assert.ok(
		css.includes('var(--crucible-sticky-pad-top'),
		'expected .crucible-settings-sticky-header to read var(--crucible-sticky-pad-top, …)',
	);
});

// WP-G1: the measured padding (F1) is correct but insufficient — a `position: sticky`
// element is clamped inside its containing block's content box, whose top sits
// `padding-top` lower than the scrollport's padding-box edge where `top: 0` pins. That
// leaves a `padding-top`-tall transparent band above the header where scrolled content
// shows through, regardless of margin/padding. The `::before` pseudo-element paints over
// that band independently of the clamp — pin its presence and its sizing formulas.
test('STRUCTURAL: a ::before pseudo-element covers the containing-block clamp band', () => {
	const css = readFileSync('styles.css', 'utf8');
	const ruleIdx = css.indexOf('.crucible-settings-sticky-header::before');
	assert.ok(ruleIdx >= 0, 'expected a .crucible-settings-sticky-header::before rule in styles.css');

	const ruleEnd = css.indexOf('}', ruleIdx);
	const rule = css.slice(ruleIdx, ruleEnd >= 0 ? ruleEnd : undefined);

	assert.ok(
		rule.includes('calc(-1 * var(--crucible-sticky-pad-top'),
		'expected ::before top to be calc(-1 * var(--crucible-sticky-pad-top, …)) to sit above the clamped header',
	);
	assert.ok(
		rule.includes('height: var(--crucible-sticky-pad-top'),
		'expected ::before height to read the same var(--crucible-sticky-pad-top, …) used for top',
	);
});
