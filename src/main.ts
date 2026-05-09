import { App, Plugin, TFile, MarkdownView, Notice, debounce, TAbstractFile, Modal, TFolder, Editor, normalizePath } from 'obsidian';
import { CrucibleSettingTab } from "./settings";
import { CrucibleSettings, DEFAULT_SETTINGS, Capture, CommandArgSchema } from "./types";
import { Materializer } from "./materialize";
import { Linter } from "./lint";
import { CaptureExecutionContext, CaptureManager, TextInputModal } from "./captures";
import { ChainManager } from "./chains";
import { ProviderManager } from "./providers";
import { AgentManager } from "./agents";
import { TableOfContentsUI } from "./toc";
import { applyTemplateString, ensureFolder, FRONTMATTER_REGEX } from './utils';
import { MoveFileFolderPickerModal, normalizeFolderPath } from './folderPicker';
import { PeriodId, getCurrentPeriodAssetFolder, getPeriodConfig, periodDisabledMessage } from './periods';
import { normalizeFrontmatterPropertyName, parseTagList, updateFrontmatter, upsertFrontmatterProperty, upsertFrontmatterTags, withMaterializing } from './frontmatter';
import { JobStore } from './orchestration/JobStore';
import { Orchestrator } from './orchestration/Orchestrator';
import { DailyBriefLiteWorkflow } from './orchestration/workflows/DailyBriefLiteWorkflow';
import { TranscriptRefinerWorkflow } from './orchestration/workflows/TranscriptRefinerWorkflow';
import { YoutubeTrackerWorkflow } from './orchestration/workflows/YoutubeTrackerWorkflow';
import { LinkScanWorkflow } from './orchestration/workflows/LinkScanWorkflow';
import { FilePickerModal } from './orchestration/FilePickerModal';
import { CrucibleSettingsView, CRUCIBLE_SETTINGS_VIEW_TYPE } from './settingsView';

export default class CruciblePlugin extends Plugin {
	settings: CrucibleSettings;
	linter: Linter;
	private isMaterializing = false;
	private materializer: Materializer;
	private captureManager: CaptureManager;
	chainManager: ChainManager;
	providerManager: ProviderManager;
	agentManager: AgentManager;
	jobStore: JobStore;
	orchestrator: Orchestrator;
	private tocComponent: TableOfContentsUI | null = null;

	async onload() {
		await this.loadSettings();

		this.materializer = new Materializer(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.linter = new Linter(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.captureManager = new CaptureManager(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.chainManager = new ChainManager(this.app);
		this.providerManager = new ProviderManager(this.app);
		this.agentManager = new AgentManager(this.app, this.settings, this.chainManager, this.providerManager);
		this.jobStore = new JobStore(this);
		this.orchestrator = new Orchestrator(this, this.jobStore);
		this.orchestrator.register('daily_brief_lite', new DailyBriefLiteWorkflow());
		this.orchestrator.register('transcript_refine', new TranscriptRefinerWorkflow());
		this.orchestrator.register('youtube_tracker', new YoutubeTrackerWorkflow());
		this.orchestrator.register('link_scan', new LinkScanWorkflow());

		this.registerInternalCommands();
		this.agentManager.registerAgents();
		this.registerChains();

		this.registerView(CRUCIBLE_SETTINGS_VIEW_TYPE, (leaf) => new CrucibleSettingsView(leaf, this));

		this.addRibbonIcon('anvil', 'Crucible settings', () => {
			this.app.setting.open();
			this.app.setting.openTabById(this.manifest.id);
		});

		// --- Commands ---
		const prefix = this.manifest.id;

		this.addCommand({ 
			id: 'materialize-day-today', 
			name: 'Materialize day: today', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-day-today')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:materialize-day-today`, {}); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'materialize-day-picker', 
			name: 'Materialize day: pick date', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-day-picker')) return false;
				if (!checking) { this.openDayPicker(); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'materialize-week-today', 
			name: 'Materialize week: current', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-week-today')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:materialize-week-today`, {}); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'materialize-week-picker', 
			name: 'Materialize week: pick week', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-week-picker')) return false;
				if (!checking) { this.openWeekPicker(); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'materialize-month-today', 
			name: 'Materialize month: current', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-month-today')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:materialize-month-today`, {}); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'materialize-month-picker', 
			name: 'Materialize month: pick month', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('materialize-month-picker')) return false;
				if (!checking) { this.openMonthPicker(); }
				return true;
			}
		});

		this.addCommand({ 
			id: 'word-count', 
			name: 'Lint: word count', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('word-count')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:word-count`, {}); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'lint-note', 
			name: 'Lint: all', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('lint-note')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:lint-note`, {}); }
				return true;
			}
		});
		this.addCommand({ 
			id: 'lint-vault', 
			name: 'Lint: vault', 
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('lint-vault')) return false;
				if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:lint-vault`, {}); }
				return true;
			}
		});

		this.addCommand({
			id: 'mark-as-forwarded',
			name: 'Mark as forwarded',
			editorCallback: (editor) => {
				if (this.settings.hiddenCommands.includes('mark-as-forwarded')) return;
				void this.chainManager.executeInternalCommand(`${prefix}:mark-as-forwarded`, {}, null, editor);
			}
		});

		this.addCommand({
			id: 'reload-plugin',
			name: 'Reload plugin',
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('reload-plugin')) return false;
				if (!checking) {
					void (async () => {
						if (this.app.plugins) {
							await this.app.plugins.disablePlugin(this.manifest.id);
							await this.app.plugins.enablePlugin(this.manifest.id);
							new Notice('Plugin reloaded');
						}
					})();
				}
				return true;
			},
		});

		this.addCommand({
			id: 'open-settings-tab',
			name: 'Open settings in a tab',
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes('open-settings-tab')) return false;
				if (!checking) { void this.activateSettingsView(); }
				return true;
			},
		});

		this.registerMoveFileCommands(prefix);

		this.addCommand({
			id: 'orchestrator-scan',
			name: 'Orchestrate: scan',
			callback: () => { void this.orchestrator.scan(); },
		});

		this.addCommand({
			id: 'orchestrator-run-next',
			name: 'Orchestrate: run next',
			callback: () => { void this.orchestrator.runNext(); },
		});

		this.addCommand({
			id: 'orchestrator-enqueue-daily-brief-lite',
			name: 'Orchestrate: enqueue daily brief lite',
			callback: () => { void this.orchestrator.enqueue('daily_brief_lite'); },
		});

		this.addCommand({
			id: 'orchestrator-enqueue-transcript-refine',
			name: 'Orchestrate: enqueue transcript refine',
			callback: () => {
				new FilePickerModal(this.app, 'Pick a transcript note', (file) => {
					void this.orchestrator.enqueue('transcript_refine', { targetPath: file.path });
				}).open();
			},
		});

		this.addCommand({
			id: 'orchestrator-enqueue-youtube-tracker',
			name: 'Orchestrate: enqueue YouTube tracker',
			callback: () => { void this.orchestrator.enqueue('youtube_tracker'); },
		});

		this.addCommand({
			id: 'orchestrator-enqueue-link-scan',
			name: 'Orchestrate: enqueue link scan',
			callback: () => { void this.orchestrator.enqueue('link_scan'); },
		});

		// --- Events ---
		this.registerEvent(this.app.vault.on('create', (file) => { void this.handleFileCreate(file); }));

		const debouncedLint = debounce(async (file: TFile) => {
			if (this.settings.lintOnSave && !this.isMaterializing) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file?.path === file.path) {
					await this.linter.lintNote(activeView);
				}
			}
		}, 2000, true);

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') debouncedLint(file);
		}));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle('Lint notes in folder')
							.setIcon('check-circle')
							.onClick(async () => {
								await this.linter.lintFolder(file);
							});
					});
				}
			})
		);

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshToC()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.refreshToC()));

		this.registerShortcuts();
		this.registerCaptures();
		this.addSettingTab(new CrucibleSettingTab(this.app, this));
		
		this.refreshToC();
	}

	onunload() {
		if (this.tocComponent) this.tocComponent.unload();
	}

	async loadSettings() { 
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CrucibleSettings>); 
		await this.migrateSettings();
	}
	
	private async migrateSettings() {
		// Pre-1.0 migrations only. Add real migrations here once the data model ships.
		return Promise.resolve();
	}

	registerAgents() {
		this.agentManager.registerAgents();
	}

	async saveSettings() { 
		await this.saveData(this.settings); 
	}

	refreshToC() {
		if (this.tocComponent) { this.tocComponent.unload(); this.tocComponent = null; }
		if (!this.settings.showToC) return;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			this.tocComponent = new TableOfContentsUI(this.app, activeView, this.settings.tocPosition, this.settings.tocCollapseBehavior);
			this.tocComponent.load();
		}
	}

	registerShortcuts() {
		this.settings.shortcuts.forEach((shortcut, index) => {
			if (!shortcut.name || !shortcut.file) return;
			const id = `shortcut-${index}`;
			this.addCommand({
				id,
				name: `Shortcut: ${shortcut.name}`,
				checkCallback: (checking: boolean) => {
					if (this.settings.hiddenCommands.includes(id)) return false;
					if (!checking) {
						void (async () => {
							const file = this.app.vault.getAbstractFileByPath(shortcut.file);
							if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
						})();
					}
					return true;
				}
			});
		});
	}

	private registerMoveFileCommands(prefix: string): void {
		const moveDailyId = 'move-current-file-to-daily-folder';
		const moveFolderId = 'move-current-file-to-folder';

		this.chainManager.registerInternalCommand(
			`${prefix}:${moveDailyId}`,
			async (_args, _prev, _editor, targetFile) => {
				if (!this.settings.dailyEnabled) {
					new Notice(periodDisabledMessage('daily'));
					return false;
				}
				return await this.moveFileToFolder(getCurrentPeriodAssetFolder(this.settings, 'daily'), targetFile);
			},
		);

		this.chainManager.registerInternalCommand(
			`${prefix}:${moveFolderId}`,
			async (args, _prev, _editor, targetFile) => {
				const folder = args.folder?.trim();
				if (folder) return await this.moveFileToFolder(folder, targetFile);
				return await this.openMoveFileFolderPicker(targetFile);
			},
			[
				{
					id: 'folder',
					name: 'Destination folder',
					type: 'folder',
					description: 'Folder to move the current file into. Leave empty to show the folder picker.',
				},
			],
		);

		this.addCommand({
			id: moveDailyId,
			name: 'Move current file to daily folder',
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes(moveDailyId)) return false;
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;
				if (!checking) {
					if (!this.settings.dailyEnabled) {
						new Notice(periodDisabledMessage('daily'));
						return true;
					}
					void this.moveFileToFolder(getCurrentPeriodAssetFolder(this.settings, 'daily'), activeFile);
				}
				return true;
			},
		});

		this.addCommand({
			id: moveFolderId,
			name: 'Move current file to folder...',
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes(moveFolderId)) return false;
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return false;
				if (!checking) void this.openMoveFileFolderPicker(activeFile);
				return true;
			},
		});
	}

	private async openMoveFileFolderPicker(targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file to move.');
			return false;
		}

		return await new Promise<boolean>((resolve) => {
			new MoveFileFolderPickerModal(
				this.app,
				this.settings,
				async (folderPath) => {
					resolve(await this.moveFileToFolder(folderPath, file));
				},
				() => resolve(false),
			).open();
		});
	}

	private async moveFileToFolder(folderPath: string, targetFile?: TFile): Promise<boolean> {
		try {
			const file = targetFile ?? this.app.workspace.getActiveFile();
			if (!file) {
				new Notice('No active file to move.');
				return false;
			}

			const normalizedFolder = normalizeFolderPath(folderPath);
			if (!normalizedFolder) {
				new Notice('Move target folder is not configured.');
				return false;
			}

			await ensureFolder(this.app, normalizedFolder);
			const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);
			if (targetPath === file.path) {
				new Notice(`Already in ${normalizedFolder}`);
				return true;
			}

			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (existing) {
				new Notice(`Move target already exists: ${targetPath}`);
				return false;
			}

			await this.app.fileManager.renameFile(file, targetPath);
			new Notice(`Moved to ${normalizedFolder}`);
			return true;
		} catch (e) {
			new Notice(`Error moving file: ${(e as Error).message}`);
			return false;
		}
	}

	registerCaptures() {
		const prefix = this.manifest.id;
		this.settings.captures.forEach((capture, index) => {
			if (!capture.name) return;
			const id = `capture-${index}`;
			const fullId = `${prefix}:${id}`;

			// Register in ChainManager so it can handle args/responses
			this.chainManager.registerInternalCommand(fullId, async (args, prev, editor, targetFile) => {
				const resolvedValue = args._default || await this.resolveCaptureValue(capture, editor);
				if (resolvedValue === null) return false;
				return await this.captureManager.executeCapture(
					capture,
					resolvedValue,
					targetFile,
					this.resolveCaptureContext(editor),
				);
			});

			this.addCommand({
				id,
				name: `Capture: ${capture.name}`,
				editorCheckCallback: (checking: boolean, editor: Editor) => {
					if (this.settings.hiddenCommands.includes(id)) return false;
					if (!checking) {
						void (async () => {
							const value = await this.resolveCaptureValue(capture, editor);
							if (value === null) return; 
							
							await this.captureManager.executeCapture(
								capture,
								value,
								undefined,
								this.resolveCaptureContext(editor),
							);
						})();
					}
					return true;
				}
			});
		});
	}

	private async resolveCaptureValue(capture: Capture, editor?: Editor): Promise<string | null> {
		const source = capture.source || 'dialog';
		
		switch (source) {
			case 'line':
				if (editor) return editor.getLine(editor.getCursor().line);
				break;
			case 'line-fallback':
				if (editor) {
					const line = editor.getLine(editor.getCursor().line);
					if (line.trim()) return line;
				}
				return await this.promptForCaptureValue(capture);
			case 'selection':
				if (editor) return editor.getSelection();
				break;
			case 'selection-fallback':
				if (editor) {
					const selection = editor.getSelection();
					if (selection.trim()) return selection;
				}
				return await this.promptForCaptureValue(capture);
			case 'dialog':
			default:
				return await this.promptForCaptureValue(capture);
		}
		return '';
	}

	private resolveCaptureContext(editor?: Editor): CaptureExecutionContext {
		return {
			sourceSectionHeader: editor ? findCurrentSectionHeader(editor) : null,
		};
	}

	private async promptForCaptureValue(capture: Capture): Promise<string | null> {
		return new Promise((resolve) => {
			new TextInputModal(
				this.app, 
				`Capture: ${capture.name}`, 
				(value) => {
					resolve(value);
				},
				() => { 
					this.refreshToC(); 
					resolve(null);
				}
			).open();
		});
	}

	private openCaptureDialog(capture: Capture) {
		void (async () => {
			const value = await this.promptForCaptureValue(capture);
			if (value !== null) {
				await this.captureManager.executeCapture(capture, value);
			}
		})();
	}

	private registerInternalCommands() {
		const prefix = this.manifest.id;

		// Built-in commands
		const register = (id: string, fn: (args: Record<string, string>, prev: unknown, editor?: Editor, targetFile?: TFile) => Promise<unknown>, schema?: CommandArgSchema[]) => {
			this.chainManager.registerInternalCommand(`${prefix}:${id}`, fn, schema);
			this.chainManager.registerInternalCommand(`crucible:${id}`, fn, schema);
		};

		register('lint-note', async (_a, _p, _e, tf) => await this.linter.lintNote(tf));
		register('lint-vault', async () => await this.linter.lintVault());
		register('word-count', async (_a, _p, _e, tf) => await this.linter.lintNote(tf));
		register('materialize-day-today', async () => await this.materializer.materializeDay(window.moment()));
		register('materialize-week-today', async () => await this.materializer.materializeWeek(window.moment()));
		register('materialize-month-today', async () => await this.materializer.materializeMonth(window.moment()));

		// --- Sources: produce content for chain steps via {{response}} ---
		register('source:active-file', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const content = await this.app.vault.read(file);
			return content.replace(FRONTMATTER_REGEX, '').trim();
		});

		register('copy-active-file', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const content = await this.app.vault.read(file);
			await navigator.clipboard.writeText(content);
			new Notice('Note copied to clipboard');
			return true;
		});

		register('source:selection', async (args, prev, editor) => {
			if (!editor) throw new Error('No editor available');
			return editor.getSelection();
		});

		register('source:input', async (args) => {
			const title = args.title || 'Input';
			return await new Promise<string | false>((resolve) => {
				let submitted = false;
				new TextInputModal(
					this.app,
					title,
					(value) => { submitted = true; resolve(value); },
					() => { if (!submitted) resolve(false); }
				).open();
			});
		}, [
			{ id: 'title', name: 'Title', type: 'text', description: 'Heading shown above the input box.' }
		]);
		
		register('mark-as-forwarded', async (args, prev, editor) => {
			if (!editor) return false;
			const cursor = editor.getCursor();
			const lineNum = cursor.line;
			const line = editor.getLine(lineNum);
			const checkboxRegex = /^(\s*[-*+]\s+\[) (\]\s+.*)$/;
			if (checkboxRegex.test(line)) {
				const newLine = line.replace(checkboxRegex, '$1>$2');
				editor.setLine(lineNum, newLine);
				editor.setCursor(cursor);
				return true;
			}
			return false;
		});

		register('upsert-tags', async (args, _p, _e, tf) => {
			return await this.upsertActiveFileTags(args.tags || '', tf);
		}, [
			{ id: 'tags', name: 'Tags', type: 'textarea', description: 'Tags to add to the active note frontmatter. Use commas, spaces, or one per line. Leading # is optional.' }
		]);

		register('upsert-property', async (args, _p, _e, tf) => {
			return await this.upsertActiveFileProperty(args.property || '', args.value || '', tf);
		}, [
			{ id: 'property', name: 'Property', type: 'text', description: 'Frontmatter property name to create or update on the active note.' },
			{ id: 'value', name: 'Value', type: 'textarea', description: 'Value to write to the property. Supports {{response}} from the previous chain step.' }
		]);

		register('copy-note-to-folder', async (args, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const folder = args.folder?.trim();
			if (!folder) throw new Error('No destination folder specified');
			if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
			const destPath = `${folder}/${file.name}`;
			const exists = this.app.vault.getFileByPath(destPath);
			if (exists) { new Notice(`Copy already exists: ${destPath}`); return destPath; }
			const content = await this.app.vault.read(file);
			await this.app.vault.create(destPath, content);
			new Notice(`Copied to ${destPath}`);
			return destPath;
		}, [
			{ id: 'folder', name: 'Destination folder', type: 'folder', description: 'Vault folder to copy the current note into.' }
		]);

		register('replace-note-body', async (args, prev, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') throw new Error('No active Markdown file');
			const replacement = args.content || (typeof prev === 'string' ? prev : '');
			if (!replacement) throw new Error('No replacement content provided');
			const existing = await this.app.vault.read(file);
			const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n/);
			const frontmatter = fmMatch ? fmMatch[0] : '';
			await withMaterializing(state => { this.isMaterializing = state; }, async () => {
				await this.app.vault.modify(file, frontmatter + replacement);
			});
			new Notice('Note body replaced');
			return true;
		}, [
			{ id: 'content', name: 'Content', type: 'textarea', description: 'New body for the note. If empty, uses {{response}} from the previous step.' }
		]);

		register('capture', async (args, prev, editor, tf) => {
			const name = args.name;
			const manualValue = args.value;
			const capture = this.settings.captures.find(c => c.name === name);
			if (capture) {
				const resolvedValue = manualValue || await this.resolveCaptureValue(capture, editor);
				if (resolvedValue === null) return false;
				return await this.captureManager.executeCapture(
					capture,
					resolvedValue,
					tf,
					this.resolveCaptureContext(editor),
				);
			}
			new Notice(`Capture not found: ${name}`);
			return false;
		}, [
			{ id: 'name', name: 'Capture name', type: 'text', description: 'Name of the capture workflow to trigger.' },
			{ id: 'value', name: 'Content', type: 'textarea', description: 'Optional content. If omitted, will prompt or use source.' }
		]);
	}

	private async upsertActiveFileTags(tagsInput: string, targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

		const newTags = parseTagList(tagsInput);
		if (newTags.length === 0) throw new Error('No tags provided');

		await withMaterializing(state => { this.isMaterializing = state; }, async () => {
			await updateFrontmatter(this.app, file, (fm) => {
				upsertFrontmatterTags(fm, tagsInput);
			});
		});

		return true;
	}

	private async upsertActiveFileProperty(property: string, value: string, targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

		const propertyName = normalizeFrontmatterPropertyName(property);
		if (!propertyName) throw new Error('Property name is required');

		await withMaterializing(state => { this.isMaterializing = state; }, async () => {
			await updateFrontmatter(this.app, file, (fm) => {
				upsertFrontmatterProperty(fm, propertyName, value);
			});
		});

		return true;
	}

	registerChains() {
		this.settings.chains.forEach((chain, index) => {
			if (!chain.name) return;
			const id = `chain-${index}`;
			this.addCommand({
				id,
				name: `Chain: ${chain.name}`,
				editorCheckCallback: (checking: boolean, editor: Editor) => {
					if (this.settings.hiddenCommands.includes(id)) return false;
					if (!checking) {
						// Capture the active file at invocation time so async steps never
						// accidentally target a different note if the user navigates away.
						const spawnFile = this.app.workspace.getActiveFile() ?? undefined;
						void this.chainManager.executeChain(chain, editor, spawnFile);
					}
					return true;
				}
			});
		});
	}

	async activateSettingsView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(CRUCIBLE_SETTINGS_VIEW_TYPE);
		const leaf = existing[0] ?? workspace.getLeaf('tab');
		if (!existing.length) {
			await leaf.setViewState({ type: CRUCIBLE_SETTINGS_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openDayPicker() {
		if (!this.settings.dailyEnabled) {
			new Notice(periodDisabledMessage('daily'));
			return;
		}
		new PickerModal(this.app, 'Pick a date', 'date', window.moment().format('YYYY-MM-DD'), (dateStr) => {
			void this.materializer.materializeDay(window.moment(dateStr, 'YYYY-MM-DD'));
		}).open();
	}

	openWeekPicker() {
		if (!this.settings.weeklyEnabled) {
			new Notice(periodDisabledMessage('weekly'));
			return;
		}
		new PickerModal(this.app, 'Pick a week', 'week', window.moment().format('GGGG-[W]WW'), (weekStr) => {
			void this.materializer.materializeWeek(window.moment(weekStr, 'GGGG-[W]WW'));
		}).open();
	}

	openMonthPicker() {
		if (!this.settings.monthlyEnabled) {
			new Notice(periodDisabledMessage('monthly'));
			return;
		}
		new PickerModal(this.app, 'Pick a month', 'month', window.moment().format('YYYY-MM'), (monthStr) => {
			void this.materializer.materializeMonth(window.moment(monthStr, 'YYYY-MM'));
		}).open();
	}

	async handleFileCreate(file: TAbstractFile) {
		if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;
		
		// CRITICAL: Only proceed if the file is truly empty to avoid overwriting existing notes on startup
		if (file.stat.size > 0) return;

		const parentPath = file.parent?.path || '';
		const fileName = file.basename;

		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'daily')) return;
		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'weekly')) return;
		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'monthly')) return;

		const mapping = this.settings.folderTemplates.find(ft => ft.folder === parentPath);
		if (mapping && mapping.template) {
			this.isMaterializing = true;
			try {
				const templateFile = this.app.vault.getAbstractFileByPath(mapping.template);
				if (templateFile instanceof TFile) {
					const templateContent = await this.app.vault.read(templateFile);
					const content = await applyTemplateString(templateContent, window.moment(), fileName);
					await this.app.vault.modify(file, content);
				}
			} catch (e) {
				new Notice(`Error applying folder template: ${(e as Error).message}`);
			} finally {
				this.isMaterializing = false;
			}
		}
	}

	private async handlePeriodFileCreate(
		file: TFile,
		parentPath: string,
		fileName: string,
		period: PeriodId,
	): Promise<boolean> {
		const config = getPeriodConfig(this.settings, period);
		if (parentPath !== config.folder) return false;

		if (!config.enabled) {
			new Notice(periodDisabledMessage(period));
			return true;
		}

		const dateMatch = fileName.match(periodFileNameRegex(period));
		if (dateMatch) {
			void this.materializePeriodFromString(period, dateMatch[1]!);
		} else {
			await this.app.fileManager.trashFile(file);
			this.openPeriodPicker(period);
		}
		return true;
	}

	private async materializePeriodFromString(period: PeriodId, value: string): Promise<boolean> {
		if (period === 'daily') return await this.materializer.materializeDay(window.moment(value, 'YYYY-MM-DD'));
		if (period === 'weekly') return await this.materializer.materializeWeek(window.moment(value, 'GGGG-[W]WW'));
		return await this.materializer.materializeMonth(window.moment(value, 'YYYY-MM'));
	}

	private openPeriodPicker(period: PeriodId): void {
		if (period === 'daily') this.openDayPicker();
		else if (period === 'weekly') this.openWeekPicker();
		else this.openMonthPicker();
	}
}

function periodFileNameRegex(period: PeriodId): RegExp {
	if (period === 'daily') return /^(\d{4}-\d{2}-\d{2})$/;
	if (period === 'weekly') return /^(\d{4}-W\d{2})$/;
	return /^(\d{4}-\d{2})$/;
}

function findCurrentSectionHeader(editor: Editor): string | null {
	for (let lineNum = editor.getCursor().line; lineNum >= 0; lineNum--) {
		const line = editor.getLine(lineNum).trim();
		if (/^#{1,6}\s+\S/.test(line)) return line;
	}
	return null;
}

class PickerModal extends Modal {
	title: string;
	type: string;
	initialValue: string;
	onSubmit: (result: string) => void;

	constructor(app: App, title: string, type: string, initialValue: string, onSubmit: (result: string) => void) {
		super(app);
		this.title = title;
		this.type = type;
		this.initialValue = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		const input = contentEl.createEl('input', { type: this.type });
		input.classList.add('crucible-picker-input');
		input.value = this.initialValue;
		const submit = contentEl.createEl('button', { text: 'Submit' });
		const triggerSubmit = () => { if (input.value) { this.onSubmit(input.value); this.close(); } };
		submit.onclick = triggerSubmit;
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerSubmit(); });
	}

	onClose() {
		this.contentEl.empty();
	}
}
