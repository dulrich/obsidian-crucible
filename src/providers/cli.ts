import { App, FileSystemAdapter, normalizePath } from 'obsidian';
import { AgentExecutionMode, Provider, ProviderKind } from '../types';

// child_process is desktop-only; loaded lazily via require so mobile bundles can still import this module.
interface ChildEvents {
	on(event: 'data', listener: (chunk: unknown) => void): unknown;
}
interface ChildStdin {
	write(chunk: string): void;
	end(): void;
	on(event: 'error', listener: (err: Error) => void): unknown;
}
interface SpawnedProcess {
	pid?: number;
	stdin: ChildStdin;
	stdout: ChildEvents;
	stderr: ChildEvents;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null) => void): unknown;
	kill(signal?: string): void;
}
type ProcessEnv = Record<string, string | undefined>;
type SpawnFn = (command: string, args: string[], options: { cwd?: string; env?: ProcessEnv }) => SpawnedProcess;

let cachedSpawn: SpawnFn | null = null;
function loadSpawn(): SpawnFn {
	if (cachedSpawn) return cachedSpawn;
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	const cp = require('child_process') as { spawn: SpawnFn };
	cachedSpawn = cp.spawn;
	return cachedSpawn;
}

export const CLI_DEFAULT_TIMEOUT_SECONDS = 120;
const CLI_DEFAULT_RUN_DIRECTORY = '_crucible/cli-runs';
const CLI_RESOLUTION_TIMEOUT_MS = 5_000;
const CLI_MAX_TIMEOUT_MS = 2_147_483_647;

export interface ProviderCompletionOptions {
	timeoutSeconds?: number;
	executionMode?: AgentExecutionMode;
	agentLabel?: string;
}

// Run a CLI-backed provider to completion: build the per-tool invocation, optionally record run
// artifacts under the vault, spawn the process (resolving the command across known bin dirs), and
// return stdout. The HTTP providers live in their own modules; this is the entire CLI surface.
export async function runCliCompletion(app: App, provider: Provider, modelId: string, system: string, user: string, options: ProviderCompletionOptions): Promise<string> {
	const command = (provider.command || '').trim() || defaultCliCommandForKind(provider.kind);
	const extraArgs = parseExtraArgs(provider.extraArgs);
	const mode: AgentExecutionMode = options.executionMode ?? 'read-only';
	const timeoutMs = resolveCliTimeoutMs(options.timeoutSeconds, provider.timeoutSeconds);
	const artifacts = createCliRunArtifacts(app, provider, options.agentLabel);

	artifacts?.writeTask(user);
	if (system) artifacts?.writeSystem(system);

	const invocation = buildCliInvocation({
		kind: provider.kind,
		modelId,
		system,
		user,
		mode,
		extraArgs,
		systemFilePath: artifacts?.systemAbsolutePath,
	});

	artifacts?.writeInvocation({
		provider: provider.name || provider.id,
		kind: provider.kind,
		model: modelId,
		command,
		args: invocation.args,
		cwd: provider.cwd?.trim() || null,
		mode,
		timeoutMs,
		stdinUsed: typeof invocation.stdin === 'string',
		readOnlyEnforcement: invocation.readOnlyEnforcement ?? null,
	});

	const stdout = await runProcess(command, invocation.args, provider.cwd, timeoutMs, artifacts, invocation.stdin);
	artifacts?.writeResponse(stdout);
	return stdout;
}

function createCliRunArtifacts(app: App, provider: Provider, agentLabel: string | undefined): CliRunArtifacts | undefined {
	if (provider.cliRunArtifactsEnabled === false) return undefined;

	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		// Mobile / non-FS vaults: skip silently.
		return undefined;
	}

	const basePath = adapter.getBasePath();
	const path = loadPath();
	const fs = loadFs();
	const rootDirectory = normalizeVaultLogDirectory(provider.cliRunDirectory);
	const absoluteRoot = path.join(basePath, rootDirectory);
	fs.mkdirSync(absoluteRoot, { recursive: true });

	const timestamp = formatLogTimestamp(new Date());
	const label = sanitizeLogName(agentLabel || provider.name || provider.id || provider.kind);
	const runDirName = `${timestamp}-${label}`;
	const absoluteRunDir = path.join(absoluteRoot, runDirName);
	fs.mkdirSync(absoluteRunDir, { recursive: true });

	const progressPath = path.join(absoluteRunDir, 'progress.log');
	const latestPath = path.join(absoluteRoot, 'latest.log');
	const progressStream = fs.createWriteStream(progressPath, { flags: 'a' });
	const latestStream = fs.createWriteStream(latestPath, { flags: 'w' });

	return new CliRunArtifacts(
		fs,
		path,
		absoluteRunDir,
		`${rootDirectory}/${runDirName}`,
		[progressStream, latestStream],
	);
}

function defaultCliCommandForKind(kind: ProviderKind): string {
	switch (kind) {
		case 'gemini-cli':   return 'gemini';
		case 'claude-cli':   return 'claude';
		case 'codex-cli':    return 'codex';
		case 'opencode-cli': return 'opencode';
		default: throw new Error(`Unsupported CLI provider kind: ${kind}`);
	}
}

interface CliInvocation {
	args: string[];
	stdin?: string;
	readOnlyEnforcement?: 'native' | 'best-effort';
}

interface BuildCliInvocationParams {
	kind: ProviderKind;
	modelId: string;
	system: string;
	user: string;
	mode: AgentExecutionMode;
	extraArgs: string[];
	systemFilePath: string | undefined;
}

function buildCliInvocation(p: BuildCliInvocationParams): CliInvocation {
	switch (p.kind) {
		case 'claude-cli':   return buildClaudeInvocation(p);
		case 'codex-cli':    return buildCodexInvocation(p);
		case 'gemini-cli':   return buildGeminiInvocation(p);
		case 'opencode-cli': return buildOpencodeInvocation(p);
		default: throw new Error(`Unsupported CLI provider kind: ${p.kind}`);
	}
}

function buildClaudeInvocation(p: BuildCliInvocationParams): CliInvocation {
	const args: string[] = ['--bare', '--print', '--output-format', 'text', '--model', p.modelId];

	if (p.mode === 'read-only') {
		args.push('--allowed-tools', 'Read', '--permission-mode', 'dontAsk');
	} else if (p.mode === 'edit') {
		args.push('--permission-mode', 'acceptEdits');
	} else {
		args.push('--permission-mode', 'bypassPermissions');
	}

	if (p.system && p.systemFilePath) {
		args.push('--append-system-prompt-file', p.systemFilePath);
	}

	args.push(...p.extraArgs);
	args.push(p.user);

	return {
		args,
		readOnlyEnforcement: p.mode === 'read-only' ? 'native' : undefined,
	};
}

function buildCodexInvocation(p: BuildCliInvocationParams): CliInvocation {
	const args: string[] = ['exec', '--skip-git-repo-check'];

	if (p.mode === 'read-only') {
		args.push('--sandbox', 'read-only');
	} else if (p.mode === 'edit') {
		args.push('--sandbox', 'workspace-write');
	} else {
		args.push('--dangerously-bypass-approvals-and-sandbox');
	}

	args.push('-m', p.modelId);
	args.push(...p.extraArgs);
	args.push('-');

	return {
		args,
		stdin: p.system ? `${p.system}\n\n${p.user}` : p.user,
		readOnlyEnforcement: p.mode === 'read-only' ? 'native' : undefined,
	};
}

function buildGeminiInvocation(p: BuildCliInvocationParams): CliInvocation {
	const args: string[] = ['-m', p.modelId, '--output-format', 'text'];

	if (p.mode === 'read-only') {
		args.push('--approval-mode', 'plan');
	} else if (p.mode === 'edit') {
		args.push('--approval-mode', 'auto_edit');
	} else {
		args.push('--approval-mode', 'yolo');
	}

	args.push(...p.extraArgs);
	const composed = p.system ? `SYSTEM:\n${p.system}\n\nTASK:\n${p.user}` : p.user;
	args.push('--prompt', composed);

	return {
		args,
		readOnlyEnforcement: p.mode === 'read-only' ? 'native' : undefined,
	};
}

function buildOpencodeInvocation(p: BuildCliInvocationParams): CliInvocation {
	const args: string[] = ['run', '-m', p.modelId];

	if (p.mode === 'unrestricted') {
		args.push('--dangerously-skip-permissions');
	}

	args.push(...p.extraArgs);
	const composed = p.system ? `${p.system}\n\n${p.user}` : p.user;
	args.push(composed);

	return {
		args,
		readOnlyEnforcement: p.mode === 'read-only' ? 'best-effort' : undefined,
	};
}

function parseExtraArgs(raw: string | undefined): string[] {
	if (!raw) return [];
	const out: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw)) !== null) {
		out.push(match[1] ?? match[2] ?? match[3] ?? '');
	}
	return out;
}

interface CliRunInvocationMeta {
	provider: string;
	kind: string;
	model: string;
	command: string;
	args: string[];
	cwd: string | null;
	mode: AgentExecutionMode;
	timeoutMs: number;
	stdinUsed: boolean;
	readOnlyEnforcement: 'native' | 'best-effort' | null;
}

interface WriteStreamLike {
	write(chunk: string): void;
	end(chunk?: string): void;
}

class CliRunArtifacts {
	private fs: FsLike;
	private path: PathLike;
	private absoluteRunDir: string;
	private streams: WriteStreamLike[];
	vaultRunDir: string;
	systemAbsolutePath: string;

	constructor(fs: FsLike, path: PathLike, absoluteRunDir: string, vaultRunDir: string, streams: WriteStreamLike[]) {
		this.fs = fs;
		this.path = path;
		this.absoluteRunDir = absoluteRunDir;
		this.vaultRunDir = vaultRunDir;
		this.streams = streams;
		this.systemAbsolutePath = path.join(absoluteRunDir, 'system.md');
	}

	writeTask(text: string): void {
		this.fs.writeFileSync(this.path.join(this.absoluteRunDir, 'task.md'), text);
	}

	writeSystem(text: string): void {
		this.fs.writeFileSync(this.systemAbsolutePath, text);
	}

	writeInvocation(meta: CliRunInvocationMeta): void {
		const payload = {
			startedAt: new Date().toISOString(),
			...meta,
		};
		this.fs.writeFileSync(this.path.join(this.absoluteRunDir, 'invocation.json'), JSON.stringify(payload, null, 2));
		this.writeRaw([
			`# Crucible CLI run`,
			`started: ${payload.startedAt}`,
			`provider: ${meta.provider}`,
			`kind: ${meta.kind}`,
			`model: ${meta.model}`,
			`mode: ${meta.mode}`,
			`read_only_enforcement: ${meta.readOnlyEnforcement ?? 'none'}`,
			`command: ${meta.command}`,
			`args: ${JSON.stringify(meta.args)}`,
			`cwd: ${meta.cwd ?? '(default)'}`,
			`timeout_ms: ${meta.timeoutMs}`,
			`stdin_used: ${meta.stdinUsed}`,
			`run_dir: ${this.absoluteRunDir}`,
			'',
		].join('\n'));
	}

	writeResponse(text: string): void {
		this.fs.writeFileSync(this.path.join(this.absoluteRunDir, 'response.md'), text);
	}

	writeMeta(message: string): void {
		this.writeRaw(`[${new Date().toISOString()}] ${message}\n`);
	}

	writeChunk(stream: 'stdout' | 'stderr', chunk: unknown): void {
		this.writeRaw(`\n[${new Date().toISOString()}] ${stream}\n${String(chunk)}\n`);
	}

	close(message: string): void {
		this.writeMeta(message);
		for (const stream of this.streams) {
			stream.end();
		}
	}

	private writeRaw(value: string): void {
		for (const stream of this.streams) {
			stream.write(value);
		}
	}
}

function normalizeVaultLogDirectory(raw: string | undefined): string {
	return normalizePath(raw?.trim() || CLI_DEFAULT_RUN_DIRECTORY)
		.replace(/^\/+/, '')
		.replace(/\/+$/, '') || CLI_DEFAULT_RUN_DIRECTORY;
}

function formatLogTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

function sanitizeLogName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'cli';
}

function resolveCliTimeoutMs(overrideSeconds: number | undefined, providerSeconds: number | undefined): number {
	const seconds = normalizeTimeoutSeconds(overrideSeconds) ??
		normalizeTimeoutSeconds(providerSeconds) ??
		CLI_DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.ceil(seconds * 1000), CLI_MAX_TIMEOUT_MS);
}

function normalizeTimeoutSeconds(value: number | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value <= 0) return null;
	return value;
}

async function runProcess(command: string, args: string[], cwd: string | undefined, timeoutMs: number, artifacts?: CliRunArtifacts, stdin?: string): Promise<string> {
	const resolved = await resolveCliCommand(command, cwd);
	return await runProcessOnce(resolved.command, args, cwd, timeoutMs, command, resolved.env, artifacts, stdin);
}

interface ResolvedCliCommand {
	command: string;
	env?: ProcessEnv;
}

async function resolveCliCommand(command: string, cwd: string | undefined): Promise<ResolvedCliCommand> {
	if (isCommandPath(command)) {
		return { command, env: envWithPrependedPath(commandDir(command)) };
	}
	if (!isBareCommand(command)) return { command };

	const pathResolved = resolveBareCommandFromKnownPaths(command);
	if (pathResolved) return pathResolved;

	const shellResolved = await resolveBareCommandWithUserShell(command, cwd);
	return shellResolved ?? { command };
}

function isBareCommand(command: string): boolean {
	return command.length > 0 && !/[\\/]/.test(command) && !/\s/.test(command);
}

function isCommandPath(command: string): boolean {
	return command.length > 0 && /[\\/]/.test(command) && !/\s/.test(command);
}

function commandDir(command: string): string {
	const slash = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\'));
	return slash === -1 ? '' : command.slice(0, slash);
}

function resolveBareCommandFromKnownPaths(command: string): ResolvedCliCommand | null {
	const dirs = collectKnownExecutableDirs();
	const executable = findExecutableInDirs(command, dirs);
	if (!executable) return null;
	return { command: executable, env: envWithPrependedPath(commandDir(executable)) };
}

function collectKnownExecutableDirs(): string[] {
	const proc = loadProcess();
	const path = loadPath();
	const home = loadOs().homedir();
	const dirs: string[] = [];

	addPathEntries(dirs, proc.env.PATH);
	addDir(dirs, proc.env.NVM_BIN);
	addDir(dirs, proc.env.PNPM_HOME);
	addDir(dirs, proc.env.BUN_INSTALL ? path.join(proc.env.BUN_INSTALL, 'bin') : undefined);
	addDir(dirs, proc.env.VOLTA_HOME ? path.join(proc.env.VOLTA_HOME, 'bin') : undefined);
	addDir(dirs, proc.env.npm_config_prefix ? path.join(proc.env.npm_config_prefix, 'bin') : undefined);

	addDir(dirs, path.join(home, '.local', 'bin'));
	addDir(dirs, path.join(home, 'bin'));
	addDir(dirs, path.join(home, '.npm-global', 'bin'));
	addDir(dirs, path.join(home, '.yarn', 'bin'));
	addDir(dirs, path.join(home, '.volta', 'bin'));
	addDir(dirs, path.join(home, '.asdf', 'shims'));
	addDir(dirs, path.join(home, '.local', 'share', 'mise', 'shims'));

	addVersionedBinDirs(dirs, path.join(home, '.nvm', 'versions', 'node'), version => path.join(home, '.nvm', 'versions', 'node', version, 'bin'));
	addVersionedBinDirs(dirs, path.join(home, '.fnm', 'node-versions'), version => path.join(home, '.fnm', 'node-versions', version, 'installation', 'bin'));

	return dirs;
}

function addPathEntries(dirs: string[], rawPath: string | undefined): void {
	if (!rawPath) return;
	for (const dir of rawPath.split(loadPath().delimiter)) {
		addDir(dirs, dir);
	}
}

function addDir(dirs: string[], dir: string | undefined): void {
	const normalized = dir?.trim();
	if (!normalized || dirs.includes(normalized)) return;
	dirs.push(normalized);
}

function addVersionedBinDirs(dirs: string[], root: string, toBinDir: (version: string) => string): void {
	for (const version of safeReadDir(root).sort(compareVersionDirsDesc)) {
		addDir(dirs, toBinDir(version));
	}
}

function compareVersionDirsDesc(left: string, right: string): number {
	const leftParts = parseVersionParts(left);
	const rightParts = parseVersionParts(right);
	const count = Math.max(leftParts.length, rightParts.length);
	for (let i = 0; i < count; i++) {
		const diff = (rightParts[i] ?? 0) - (leftParts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return right.localeCompare(left);
}

function parseVersionParts(value: string): number[] {
	return (value.match(/\d+/g) ?? []).map(part => Number(part));
}

function safeReadDir(path: string): string[] {
	try {
		return loadFs().readdirSync(path);
	} catch {
		return [];
	}
}

function findExecutableInDirs(command: string, dirs: string[]): string | null {
	const path = loadPath();
	for (const dir of dirs) {
		for (const name of executableNames(command)) {
			const candidate = path.join(dir, name);
			if (isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}

function executableNames(command: string): string[] {
	const proc = loadProcess();
	if (proc.platform !== 'win32' || /\.[^\\/]+$/.test(command)) return [command];
	const extensions = (proc.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
	return [command, ...extensions.map(ext => `${command}${ext.toLowerCase()}`), ...extensions.map(ext => `${command}${ext.toUpperCase()}`)];
}

function isExecutableFile(path: string): boolean {
	const fs = loadFs();
	try {
		if (loadProcess().platform === 'win32') {
			return fs.existsSync(path);
		}
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveBareCommandWithUserShell(command: string, cwd: string | undefined): Promise<ResolvedCliCommand | null> {
	const proc = loadProcess();
	if (proc.platform === 'win32') return Promise.resolve(null);

	const script = `resolved=$(command -v ${shellQuote(command)}); status=$?; if [ "$status" -eq 0 ]; then printf '__CRUCIBLE_COMMAND__%s\\n' "$resolved"; printf '__CRUCIBLE_PATH__%s\\n' "$PATH"; fi; exit "$status"`;

	for (const shell of collectPosixShells()) {
		for (const args of shellLookupArgs(shell, script)) {
			const resolved = await runProcessOnce(shell, args, cwd, CLI_RESOLUTION_TIMEOUT_MS, shell)
				.then(parseShellResolution)
				.catch(() => null);
			if (resolved) return resolved;
		}
	}
	return null;
}

function collectPosixShells(): string[] {
	const path = loadPath();
	const proc = loadProcess();
	const candidates = [
		proc.env.SHELL,
		'/bin/bash',
		'/usr/bin/bash',
		'/bin/zsh',
		'/usr/bin/zsh',
		'/bin/sh',
		'/usr/bin/sh',
	];
	return candidates
		.filter((shell): shell is string => !!shell && isPosixShellName(path.basename(shell)) && isExecutableFile(shell))
		.filter((shell, index, shells) => shells.indexOf(shell) === index);
}

function isPosixShellName(name: string): boolean {
	return ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(name);
}

function shellLookupArgs(shell: string, script: string): string[][] {
	const name = loadPath().basename(shell);
	const args = [['-lc', script]];
	if (name === 'bash' || name === 'zsh') args.push(['-ic', script]);
	return args;
}

function parseShellResolution(stdout: string): ResolvedCliCommand | null {
	const lines = stdout.split(/\r?\n/);
	const resolvedCommand = lines.find(line => line.startsWith('__CRUCIBLE_COMMAND__'))?.slice('__CRUCIBLE_COMMAND__'.length).trim();
	const resolvedPath = lines.find(line => line.startsWith('__CRUCIBLE_PATH__'))?.slice('__CRUCIBLE_PATH__'.length);
	if (!resolvedCommand) return null;
	return {
		command: resolvedCommand,
		env: resolvedPath ? envWithPath(resolvedPath) : undefined,
	};
}

function envWithPrependedPath(dir: string): ProcessEnv | undefined {
	if (!dir) return undefined;
	const proc = loadProcess();
	const delimiter = proc.platform === 'win32' ? ';' : ':';
	const currentPath = proc.env.PATH || '';
	return envWithPath(currentPath ? `${dir}${delimiter}${currentPath}` : dir);
}

function envWithPath(path: string): ProcessEnv {
	const proc = loadProcess();
	return { ...proc.env, PATH: path };
}

interface ProcessLike {
	env: ProcessEnv;
	platform: string;
}

function loadProcess(): ProcessLike {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	return require('process') as ProcessLike;
}

interface FsLike {
	constants: { X_OK: number };
	accessSync(path: string, mode?: number): void;
	createWriteStream(path: string, options?: { flags?: string }): WriteStreamLike;
	existsSync(path: string): boolean;
	mkdirSync(path: string, options?: { recursive?: boolean }): void;
	readdirSync(path: string): string[];
	writeFileSync(path: string, data: string): void;
}

function loadFs(): FsLike {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	return require('fs') as FsLike;
}

interface PathLike {
	delimiter: string;
	basename(path: string): string;
	join(...paths: string[]): string;
}

function loadPath(): PathLike {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	return require('path') as PathLike;
}

interface OsLike {
	homedir(): string;
}

function loadOs(): OsLike {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	return require('os') as OsLike;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runProcessOnce(command: string, args: string[], cwd: string | undefined, timeoutMs: number, displayCommand: string, env?: ProcessEnv, artifacts?: CliRunArtifacts, stdin?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const spawn = loadSpawn();
		const child = spawn(command, args, {
			cwd: cwd && cwd.trim() ? cwd : undefined,
			env,
		});
		const commandLabel = displayCommand === command ? command : `${displayCommand} -> ${command}`;
		artifacts?.writeMeta(`spawned: ${commandLabel}`);
		if (child.pid !== undefined) artifacts?.writeMeta(`pid: ${child.pid}`);

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { child.kill('SIGTERM'); } catch { /* ignore */ }
			artifacts?.close(`timed out after ${timeoutMs}ms`);
			reject(new Error(`CLI provider "${commandLabel}" timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on('data', (chunk: unknown) => {
			stdout += String(chunk);
			artifacts?.writeChunk('stdout', chunk);
		});
		child.stderr.on('data', (chunk: unknown) => {
			stderr += String(chunk);
			artifacts?.writeChunk('stderr', chunk);
		});

		child.on('error', (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const hint = isBareCommand(displayCommand) && err.message.includes('ENOENT')
				? '; command was not found via Obsidian PATH, common user bin directories, or shell lookup. Set the provider Command to an absolute executable path if this persists.'
				: '';
			artifacts?.close(`failed to start: ${err.message}`);
			reject(new Error(`CLI provider "${commandLabel}" failed to start: ${err.message}${hint}`));
		});

		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				const trimmedErr = stderr.trim() || stdout.trim() || `exit ${code}`;
				artifacts?.close(`exited with ${code}`);
				reject(new Error(`CLI provider "${commandLabel}" exited with ${code}: ${trimmedErr}`));
				return;
			}
			artifacts?.close('completed with exit code 0');
			resolve(stdout);
		});

		if (typeof stdin === 'string') {
			try {
				child.stdin.on('error', () => { /* spawn already failed; let close/error handlers report */ });
				child.stdin.write(stdin);
				child.stdin.end();
			} catch (err) {
				artifacts?.writeMeta(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else {
			try { child.stdin.end(); } catch { /* ignore */ }
		}
	});
}
