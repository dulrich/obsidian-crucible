import { App, requestUrl } from 'obsidian';
import { Provider } from './types';

export const providerSecretKey = (id: string) => `crucible-provider-${id}-key`;

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

	async complete(provider: Provider, system: string, user: string): Promise<string> {
		const apiKey = provider.type === 'ollama' ? '' : await this.loadApiKey(provider.id);
		if (!apiKey && provider.type !== 'ollama') {
			throw new Error(`API key missing for provider "${provider.name || provider.id}"`);
		}

		switch (provider.type) {
			case 'openai':
				return await this.callOpenAI(provider, apiKey, system, user);
			case 'anthropic':
				return await this.callAnthropic(provider, apiKey, system, user);
			case 'google':
				return await this.callGoogle(provider, apiKey, system, user);
			case 'openrouter':
				return await this.callOpenRouter(provider, apiKey, system, user);
			case 'ollama':
				return await this.callOllama(provider, system, user);
			default:
				throw new Error("Unsupported provider type: " + (provider.type as string));
		}
	}

	private async callOpenAI(provider: Provider, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.openai.com/v1/chat/completions',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: provider.model,
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

	private async callAnthropic(provider: Provider, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.anthropic.com/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: provider.model,
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

	private async callGoogle(provider: Provider, apiKey: string, system: string, user: string): Promise<string> {
		const response = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${apiKey}`,
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

	private async callOpenRouter(provider: Provider, apiKey: string, system: string, user: string): Promise<string> {
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
				model: provider.model,
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

	private async callOllama(provider: Provider, system: string, user: string): Promise<string> {
		const baseUrl = provider.baseUrl || 'http://localhost:11434';
		const response = await requestUrl({
			url: `${baseUrl}/api/chat`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: provider.model,
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
}
