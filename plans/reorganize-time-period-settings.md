# Reorganize Daily/Weekly/Monthly Period Settings

  ## Summary

  Rework the Configure settings page around three period feature blocks: Daily, Weekly, and Monthly. Each block owns its enable toggle, root folder, date-specific asset-folder toggle,
  template, and Move-to-folder pin toggle. Keep additional custom Move-to-folder pins in a separate Pinned folders section. Disabled period features remain visible, but actions fail
  fast with clear warnings instead of silently hiding.

  ## Key Changes

  - Add settings fields:
      - dailyEnabled, weeklyEnabled, monthlyEnabled, default true.
      - dailyCreateAssetFolder, weeklyCreateAssetFolder, monthlyCreateAssetFolder.
      - Defaults preserve current behavior: Daily asset folder true, Weekly/Monthly false.
  - Keep existing folder/template fields for compatibility:
      - dailyFolder, weeklyFolder, monthlyFolder
      - dailyTemplate, weeklyTemplate, monthlyTemplate
      - Existing move pin booleans remain but move into each period block.
  - Update materialization behavior:
      - Daily note remains {{dailyFolder}}/YYYY-MM-DD.md.
      - Weekly note remains {{weeklyFolder}}/YYYY-Www.md.
      - Monthly note remains {{monthlyFolder}}/YYYY-MM.md.
      - If asset-folder toggle is enabled, also create matching folder beside the note:
          - Daily: {{dailyFolder}}/YYYY-MM-DD/
          - Weekly: {{weeklyFolder}}/YYYY-Www/
          - Monthly: {{monthlyFolder}}/YYYY-MM/
  - Disabled period contract:
      - Palette/internal materialize commands stay registered but return a warning Notice and do not run.
      - File-create hooks for disabled period roots do not materialize; they show a warning Notice when triggered.
      - Captures targeting a disabled period return false with a warning Notice.
      - Daily Brief fails/skips clearly if Daily is disabled.
      - Move-to-folder period pins are omitted when that period is disabled.
  - Settings UI:
      - Replace current separate “Folders”, “Move file picker”, and “Core templates” period controls with grouped .crucible-settings-group blocks: Daily, Weekly, Monthly.
      - Each disabled block shows a warning icon/marker and explanatory text.
      - Captures/workflows that depend on a disabled period show a warning icon in their settings list/editor.
      - Add a separate “Pinned folders” settings section for only moveFilePinnedFolders.

  ## Implementation Notes

  - Introduce a small helper for period config lookup so Daily/Weekly/Monthly command, capture, hook, and picker behavior share one source of truth.
  - Refactor Materializer to accept period config rather than hardcoding Daily-only asset folder creation.
  - Update folderPicker to include period pins only when both the period is enabled and its pin toggle is enabled.
  - Preserve command IDs and existing setting keys wherever possible so existing chains, hotkeys, and saved settings continue working.

  ## Test Plan

  - npm run lint
  - npx tsc -noEmit -skipLibCheck
  - node esbuild.config.mjs production
  - Manual scenarios:
      - Materialize Daily/Weekly/Monthly with asset folders on/off.
      - Disable each period and confirm commands show warning Notices and do not create files.
      - Create empty date/week/month files in configured roots and verify hooks respect enabled/disabled state.
      - Run captures targeting Daily/Weekly/Monthly with each feature enabled and disabled.
      - Open Move current file to folder picker and confirm enabled period pins plus custom pins appear above normal folders.
      - Disable Daily and confirm Daily Brief fails/skips with a clear message.

  ## Assumptions

  - “Daily capture folder” means the date-specific folder currently created beside the daily note; the plan renames this concept internally/UI-wise to “asset folder” for all periods.
  - Existing vault structure is not migrated or moved; settings only affect future materialization.
  - Disabled features should not unregister commands, because the desired behavior is an explicit warning/error message when invoked.
