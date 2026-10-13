import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nextVersion } from '../version-bump.mjs';

const SCRIPT = resolve('version-bump.mjs');

test('nextVersion applies the AGENTS.md versioning levels', () => {
	assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
	assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
	assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
	assert.throws(() => nextVersion('1.2.3', 'prerelease'), /level must be/);
	assert.throws(() => nextVersion('1.2', 'patch'), /x\.y\.z/);
});

function fixture(pkgVersion, manifestVersion) {
	const dir = mkdtempSync(join(tmpdir(), 'crucible-bump-'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }));
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: 'x', version: manifestVersion, minAppVersion: '0.15.0' }));
	writeFileSync(join(dir, 'versions.json'), JSON.stringify({ [manifestVersion]: '0.15.0' }));
	return dir;
}
const read = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

test('bump writes package.json, manifest.json and versions.json in lockstep', () => {
	const dir = fixture('1.0.0', '1.0.0');
	const out = execFileSync('node', [SCRIPT, 'minor'], { cwd: dir, encoding: 'utf8' });
	assert.equal(out.trim(), '1.1.0');
	assert.equal(read(dir, 'package.json').version, '1.1.0');
	assert.equal(read(dir, 'manifest.json').version, '1.1.0');
	assert.deepEqual(read(dir, 'versions.json'), { '1.0.0': '0.15.0', '1.1.0': '0.15.0' });
});

test('bump refuses when package.json and manifest.json disagree, writing nothing', () => {
	const dir = fixture('1.0.0', '1.0.1');
	assert.throws(() => execFileSync('node', [SCRIPT, 'patch'], { cwd: dir, stdio: 'pipe' }));
	assert.equal(read(dir, 'package.json').version, '1.0.0');
	assert.equal(read(dir, 'manifest.json').version, '1.0.1');
});
