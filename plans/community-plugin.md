### Phase 1: v0.9 Initial Beta Release (Current Repository)
**Objective:** Publish the current state of Crucible to the Obsidian Community Plugins repository to gather initial user feedback and ensure the core architecture complies with Obsidian's strict review guidelines.

#### 1. Preparation & Validation
*   **Manifest Check (`manifest.json`)**:
    *   Ensure the `description` is under 250 characters, ends with a period, and does not start with redundant phrases like "This is a plugin".
    *   Verify trademark capitalization (e.g., "Obsidian", "Markdown").
    *   Confirm `isDesktopOnly` is correctly set. If the plugin uses Node.js or Electron APIs (like `fs`, `os`), it must be `true`.
*   **Documentation**: Ensure the `README.md` at the root of the repository clearly explains the plugin's purpose, how to use it, and any initial setup required.
*   **Quality Assurance**: Run the mandatory **Full Cleanup Loop** (`npm run lint`, type-checking, and `npm run build`) to ensure there are no errors or hanging processes.

#### 2. Packaging and GitHub Release
*   Update the version number in `package.json` and `manifest.json` to `0.9.0`.
*   Build the final production assets using `npm run build`.
*   Commit the version bump and create a git tag: `git tag 0.9.0`.
*   Push the commit and tag to your GitHub repository.
*   Create a **GitHub Release** targeting the `0.9.0` tag.
*   **Critical Step**: Manually attach the compiled `main.js`, `manifest.json`, and `styles.css` (if applicable) as assets to this GitHub Release.

#### 3. Community Submission & Review
*   Fork the official [obsidian-releases](https://github.com/obsidianmd/obsidian-releases) repository.
*   Edit the `community-plugins.json` file and add the Crucible metadata block to the **very end** of the file.
*   Submit a Pull Request (PR) to the `obsidian-releases` repository. Use the PR preview mode to review their checklist.
*   The Obsidian team will review the code for security, performance, and API best practices. Address any requested changes promptly. Once merged, Crucible will appear in the community browser.

---

### Phase 2: v1.0 Release (QuickAdd AI Assistant Migration)
**Objective:** Integrate the QuickAdd AI Assistant features and officially mark the plugin as production-ready.

#### 1. Feature Migration & Implementation
*   Migrate the AI assistant logic, prompts, and execution flows into Crucible's modular architecture (likely utilizing the existing `captures.ts` or a new `ai.ts` module).
*   Update the settings UI (`settings.ts`) to securely handle any necessary API keys, model selections, or custom prompt configurations.
*   Update `README.md` to document the new AI workflows and update the development guide (`AGENTS.md`) as necessary.
*   **Generate Online Documentation**: 
    *   Create a comprehensive online documentation site explaining all plugin features, configurations, and workflows.
    *   **Review Hosting Options**: Evaluate and select a hosting platform for the documentation. Options include:
        *   **GitHub Pages**: Free, integrated with the repository, supports Jekyll or simple static HTML/Markdown (e.g., MkDocs or Docusaurus).
        *   **Vercel / Netlify**: Excellent for modern static site generators (Nextra, Starlight, Docusaurus) with automatic deployments on push.
        *   **Read the Docs**: Specifically tailored for documentation, supports Sphinx or MkDocs, versioning out of the box.
        *   **Obsidian Publish**: If you want to author the docs natively in Obsidian, though this requires a paid subscription.

#### 2. Validation
*   Test the AI integrations in an isolated vault to ensure they don't block the main Obsidian UI thread (handling asynchronous API calls cleanly).
*   Run the **Full Cleanup Loop** to guarantee type safety and styling compliance.

#### 3. Publication (Automated via GitHub)
*   Run the project's version bump script (e.g., `npm run version` or manual bump to `1.0.0` in `manifest.json` and `versions.json`).
*   Build the production assets: `npm run build`.
*   Commit the changes, tag as `1.0.0`, and push to GitHub.
*   Create a new GitHub Release for `1.0.0` and attach `main.js`, `manifest.json`, and `styles.css`.
*   *Note: Because the plugin was already approved and added to `community-plugins.json` in Phase 1, you do not need to submit another PR. Obsidian automatically detects new GitHub Releases and updates the community directory.*