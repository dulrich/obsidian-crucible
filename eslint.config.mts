import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		// Agent worktrees (`.claude/worktrees/<name>/`) are full checkouts of this repo.
		// The entries above are root-relative, so they do NOT match the nested copies —
		// without this, ESLint lints every live worktree and the gate goes red on files
		// that aren't part of the working tree at all.
		".claude/**",
		// `runs/` is gitignored scratch (dispatch briefs, reports, one-off diagnostic
		// scripts). A stray `.mjs` dropped there by a worker must not be able to redden the
		// repo lint gate — the gate is for the working tree, not for scratch that will never
		// be committed.
		"runs/**",
	]),
);
