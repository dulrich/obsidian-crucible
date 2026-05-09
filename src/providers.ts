import { App, requestUrl } from 'obsidian';
import { Provider, providerModality } from './types';

// child_process is desktop-only; loaded lazily via require so mobile bundles can still import this module.
interface ChildEvents {
	on(event: 'data', listener: (chunk: unknown) => void): unknown;
}
interface SpawnedProcess {
	stdout: ChildEvents;
	stderr: ChildEvents;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null) => void): unknown;
	kill(signal?: string): void;
}
type SpawnFn = (command: string, args: string[], options: { cwd?: string }) => SpawnedProcess;

let cachedSpawn: SpawnFn | null = null;
function loadSpawn(): SpawnFn {
	if (cachedSpawn) return cachedSpawn;
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	const cp = require('child_process') as { spawn: SpawnFn };
	cachedSpawn = cp.spawn;
	return cachedSpawn;
}

export const providerSecretKey = (id: string) => `crucible-provider-${id}-key`;

const CLI_DEFAULT_TIMEOUT_MS = 120_000;

export class ProviderManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	async loadApiKey(providerId: string): Promise<string> {
		if (!this.app.secretStorage) return '';
		return this.app.secretStorage.getSecret(providerSecretKey(providerId)) || '';
	}

	async storeApiKey(providerId: string, key: string): Promise<void> {
		if (!this.app.secretStorage) return;
		this.app.secretStorage.setSecret(providerSecretKey(providerId), key);
	}

	async deleteApiKey(providerId: string): Promise<void> {
		if (!this.app.secretStorage) return;
		// SecretStorage doesn't always have an explicit delete, so we clear it.
		this.app.secretStorage.setSecret(providerSecretKey(providerId), '');
	}

	async complete(provider: Provider, modelId: string, system: string, user: string): Promise<string> {
		if (!modelId) {
			throw new Error(`No model selected for provider "${provider.name || provider.id}"`);
		}

		if (providerModality(provider.kind) === 'cli') {
			const shape = CLI_SHAPES[provider.kind];
			if (!shape) throw new Error(`Unsupported CLI provider kind: ${provider.kind}`);
			return await this.callCli(shape, provider, modelId, system, user);
		}

		const apiKey = provider.kind === 'ollama' ? '' : await this.loadApiKey(provider.id);
		if (!apiKey && provider.kind !== 'ollama') {
			throw new Error(`API key missing for provider "${provider.name || provider.id}"`);
		}

		switch (provider.kind) {
			case 'openai':
				return await this.callOpenAI(modelId, apiKey, system, user);
			case 'anthropic':
				return await this.callAnthropic(modelId, apiKey, system, user);
			case 'google':
				return await this.callGoogle(modelId, apiKey, system, user);
			case 'openrouter':
				return await this.callOpenRouter(modelId, apiKey, system, user);
			case 'ollama':
				return await this.callOllama(provider, modelId, system, user);
			default:
				throw new Error("Unsupported provider kind: " + (provider.kind as string));
		}
	}

	private async callOpenAI(modelId: string, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.openai.com/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user }
				],
				temperature: 0.7
			})
		});

		if (response.status !== 200) {
			throw new Error(`OpenAI API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { choices: { message: { content: string } }[] };
		const choice = data.choices[0];
		if (!choice) throw new Error('OpenAI API returned no choices');
		return choice.message.content;
	}

	private async callAnthropic(modelId: string, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.anthropic.com/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: modelId,
				system: system,
				messages: [
					{ role: 'user', content: user }
				],
				max_tokens: 4096
			})
		});

		if (response.status !== 200) {
			throw new Error(`Anthropic API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { content: { text: string }[] };
		const block = data.content[0];
		if (!block) throw new Error('Anthropic API returned no content');
		return block.text;
	}

	private async callGoogle(modelId: string, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				system_instruction: system ? { parts: [{ text: system }] } : undefined,
				contents: [
					{ role: 'user', parts: [{ text: user }] }
				],
				generationConfig: {
					temperature: 0.7,
					maxOutputTokens: 4096
				}
			})
		});

		if (response.status !== 200) {
			throw new Error("Google API returned " + response.status + ": " + response.text);
		}

		const data = response.json as { candidates: { content: { parts: { text: string }[] } }[] };
		const candidate = data.candidates[0];
		const part = candidate?.content.parts[0];
		if (!part) throw new Error('Google API returned no candidates');
		return part.text;
	}

	private async callOpenRouter(modelId: string, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: 'https://openrouter.ai/api/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
				'HTTP-Referer': 'https://github.com/dulrich/obsidian-crucible',
				'X-Title': 'Crucible Obsidian Plugin'
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user }
				]
			})
		});

		if (response.status !== 200) {
			throw new Error("OpenRouter API returned " + response.status + ": " + response.text);
		}

		const data = response.json as { choices: { message: { content: string } }[] };
		const choice = data.choices[0];
		if (!choice) throw new Error('OpenRouter API returned no choices');
		return choice.message.content;
	}

	private async callOllama(provider: Provider, modelId: string, system: string, user: string): Promise<string> {
		const baseUrl = provider.baseUrl || 'http://localhost:11434';
		const response = await requestUrl({
			url: `${baseUrl}/api/chat`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user }
				],
				stream: false
			})
		});

		if (response.status !== 200) {
			throw new Error(`Ollama API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { message: { content: string } };
		return data.message.content;
	}

	private async callCli(shape: CliShape, provider: Provider, modelId: string, system: string, user: string): Promise<string> {
		const command = (provider.command || '').trim() || shape.defaultCommand;
		const extraArgs = parseExtraArgs(provider.extraArgs);
		const prompt = system ? `${system}\n\n${user}` : user;

		const args: string[] = [];
		if (shape.subcommand) args.push(shape.subcommand);
		args.push(shape.modelFlag, modelId);
		args.push(...extraArgs);
		if (shape.promptFlag) {
			args.push(shape.promptFlag, prompt);
		} else {
			args.push(prompt);
		}

		return await runProcess(command, args, provider.cwd, CLI_DEFAULT_TIMEOUT_MS);
	}
}

interface CliShape {
	defaultCommand: string;
	subcommand?: string;
	modelFlag: string;
	// If set, prompt is passed via this flag. Otherwise it's positional.
	promptFlag?: string;
}

const CLI_SHAPES: Partial<Record<Provider['kind'], CliShape>> = {
	'gemini-cli':   { defaultCommand: 'gemini',   modelFlag: '-m',      promptFlag: '-p' },
	'claude-cli':   { defaultCommand: 'claude',   modelFlag: '--model', promptFlag: '-p' },
	'codex-cli':    { defaultCommand: 'codex',    modelFlag: '-m',      subcommand: 'exec' },
	'opencode-cli': { defaultCommand: 'opencode', modelFlag: '-m',      subcommand: 'run' },
};

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

function runProcess(command: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const spawn = loadSpawn();
		const child = spawn(command, args, {
			cwd: cwd && cwd.trim() ? cwd : undefined,
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { child.kill('SIGTERM'); } catch { /* ignore */ }
			reject(new Error(`CLI provider "${command}" timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
		child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });

		child.on('error', (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`CLI provider "${command}" failed to start: ${err.message}`));
		});

		child.on('close', (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				const trimmedErr = stderr.trim() || stdout.trim() || `exit ${code}`;
				reject(new Error(`CLI provider "${command}" exited with ${code}: ${trimmedErr}`));
				return;
			}
			resolve(stdout);
		});
	});
}
