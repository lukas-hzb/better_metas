# BetterMetas Development

This guide covers local development and verification. For browser installation, see [README.md](../README.md). For contribution rules and known limitations, see [CONTRIBUTING.md](../CONTRIBUTING.md). Data-writing operations belong in [DATA_MAINTENANCE.md](DATA_MAINTENANCE.md).

## Requirements and Setup

Use a supported [Node.js LTS release](https://nodejs.org/en/about/previous-releases); Node.js 24 is recommended. The tooling uses the built-in Fetch API and has no third-party npm dependencies. Node.js, npm, and Git are development tools, not requirements for ordinary userscript installation. Python is not required.

From a terminal, clone the official branch and install the locked npm metadata:

```sh
git clone --branch main_v4 https://github.com/lukas-hzb/better_metas.git
cd better_metas
npm ci
```

For an existing checkout, run subsequent commands from its repository root. `npm start` runs the scraper and can overwrite data; it is not a development web server. There is no website to start or build step needed for the userscript.

## Repository Layout

```text
better_metas/
├── geoguessr-meta.user.js   Installable userscript and browser interface
├── data/                  Plonk It and community meta/location JSON
├── images/                README screenshots
├── scraper.js             Plonk It guide importer
├── scripts/               Location extraction, enrichment, and shared utilities
├── docs/                  Development and maintainer instructions
└── .github/workflows/     Existing community-issue automation
```

The userscript handles location detection, result-screen visibility, geographic matching, browser caching, the HUD, and GitHub-backed contributions in one file. It loads the four JSON data files from `main_v4`; changing a local JSON file alone does not change what an installed script downloads.

## Edit and Check the Userscript

Use a separate browser profile for development. Install a local copy through the userscript manager's editor and disable any other BetterMetas copy in that profile. Prevent automatic updates from overwriting local edits. Leave the GitHub token field empty.

Check syntax without executing the scripts:

```sh
node --check geoguessr-meta.user.js
node --check scraper.js
node --check scripts/cli_utils.js
node --check scripts/json_utils.js
node --check scripts/plonkit_utils.js
node --check scripts/extract_guide_locations.js
node --check scripts/enrich_tags.js
node --check scripts/enrich_scopes.js
node --check scripts/generate_titles_ai.js
```

The following enrichment previews read local JSON without writing it or calling external services:

```sh
npm run enrich:tags:dry-run
npm run enrich:scopes:dry-run
```

There is currently no `npm test` command or general CI workflow. Do not describe these syntax and preview checks as a complete automated test suite. The live scraper smoke test and other network operations are documented separately in [DATA_MAINTENANCE.md](DATA_MAINTENANCE.md).

## Manual Browser Checks

- Complete a round in a permitted practice context and verify the HUD appears on its result screen, then hides when leaving that screen.
- Review meta descriptions, images, scope filters, resizing, and closing/reopening the interface.
- Check that moving between round results does not leave clues associated with the wrong panorama.
- Verify missing data and failed requests do not break the surrounding page.
- Inspect generated contribution JSON without submitting a live GitHub issue. Opening a draft is not the same as submitting it; posting or editing a live submission can trigger repository writes.

Do not use maintainer edit/delete controls for a smoke test. They write to the official repository. If a change needs end-to-end write testing, arrange an authorized isolated target and update all relevant repository constants in the private test copy first.

## Troubleshooting and Updates

If the HUD does not appear, check userscript-manager execution permissions, confirm that only one copy is enabled, reload GeoGuessr, and test a recognized round-result screen. Collect redacted console errors rather than exporting a browser profile.

Cached data can delay visible changes. A fresh test profile avoids mixing old cached data with a new test. **Delete Saved User Data** is a maintainer repository operation, not a local cache reset.

Before publishing a userscript change, review its `@version`, `@match`, `@grant`, `@connect`, `@updateURL`, and `@downloadURL` metadata. Increment `@version` for a new userscript update. Keep the official `main_v4` distribution URLs intact; changing the branch or file path requires a deliberate migration. Documentation-only changes do not need a userscript-version bump.

README images should use meaningful captions and alt text. For related screenshots, use HTML `<img>` elements inside Markdown tables with matching widths, as in the current README.
