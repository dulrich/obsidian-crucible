// Bumps the plugin version in package.json, manifest.json and versions.json together.
// Usage: `bun run bump <patch|minor|major>` (policy: root AGENTS.md "Versioning").
// Never commits or tags — the bump rides in the plan's implementing commit.
import { readFileSync, writeFileSync } from "fs";

const LEVELS = ["patch", "minor", "major"];

export function nextVersion(current, level) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
	if (!m) throw new Error(`not a plain x.y.z version: ${current}`);
	let [major, minor, patch] = m.slice(1).map(Number);
	if (level === "major") { major++; minor = 0; patch = 0; }
	else if (level === "minor") { minor++; patch = 0; }
	else if (level === "patch") { patch++; }
	else throw new Error(`level must be one of ${LEVELS.join("|")}, got: ${level}`);
	return `${major}.${minor}.${patch}`;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);

export function bump(level) {
	const pkg = readJson("package.json");
	const manifest = readJson("manifest.json");
	if (pkg.version !== manifest.version) {
		throw new Error(`package.json (${pkg.version}) and manifest.json (${manifest.version}) disagree; reconcile first`);
	}
	const target = nextVersion(pkg.version, level);
	pkg.version = target;
	manifest.version = target;
	// Obsidian's versions.json maps every released version to its minAppVersion.
	const versions = readJson("versions.json");
	versions[target] = manifest.minAppVersion;
	writeJson("package.json", pkg);
	writeJson("manifest.json", manifest);
	writeJson("versions.json", versions);
	return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		process.stdout.write(`${bump(process.argv[2])}\n`);
	} catch (err) {
		process.stderr.write(`version-bump: ${err.message}\n`);
		process.exit(1);
	}
}
