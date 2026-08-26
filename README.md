# BetterMetas

BetterMetas is a GeoGuessr userscript that displays relevant metas and location hints directly in the game. It combines a Plonk It-derived knowledge base with geographic matching so players can study likely clues without switching to a separate website.

## Features

- **Live HUD** — Displays relevant hints, tags, and images for the current location.
- **Geographic Matching** — Suggests metas using country, region, city, road, distance, and configured scopes instead of relying only on exact panorama matches.
- **Plonk It Integration** — Includes structured entries derived from the detailed Plonk It guides.
- **Location Information** — Shows available coordinates, address details, and region names using GeoGuessr data and Nominatim enrichment.
- **Community Contributions** — Creates a pre-filled GitHub issue for new or linked metas when no maintainer token is configured.
- **Filters** — Controls which hint scopes appear, from unique clues to countrywide patterns.

### Screenshots

| Main HUD Preview                                                | Predicted Metas                                                          |
| :-------------------------------------------------------------: | :----------------------------------------------------------------------: |
| <img src="images/hud_preview.png" alt="Main HUD" width="400" /> | <img src="images/hud_preview_2.png" alt="Predicted Metas" width="400" /> |

| Add Meta Dialog                                                     | Settings Menu                                                     |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------: |
| <img src="images/add_meta_dialog.png" alt="Add Meta" width="400" /> | <img src="images/settings_menu.png" alt="Settings" width="400" /> |

## Installation

### Browser Setup

BetterMetas has no separate website or hosted web application. The userscript in this repository is the product and its only official installation artifact.

1. Install a compatible userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Open the official [`geoguessr-meta.user.js`](https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v4/geoguessr-meta.user.js) installation URL.
3. Review the requested permissions and confirm the installation in the userscript manager.
4. Open [GeoGuessr](https://www.geoguessr.com/) and start a supported game; the BetterMetas HUD should appear automatically.

The userscript manager checks the `@updateURL` and `@downloadURL` metadata on the `main_v4` branch for updates. Forks or copied files are not official update channels.

## Usage

1. Start a GeoGuessr game and wait for the HUD to identify the current panorama.
2. Review predicted metas, expand details, and filter scopes from the settings panel.
3. Add or link a meta from a result screen. Without a maintainer token, BetterMetas opens a pre-filled GitHub issue for review.
4. Use a GitHub token only for repository-maintainer workflows that write directly to the project data files.

## Development Setup

The data pipeline requires Node.js 18 or later because the title generator uses the built-in Fetch API. It does not require Python. Install the locked npm metadata with:

```bash
git clone --branch main_v4 https://github.com/lukas-hzb/better_metas.git
cd better_metas
npm ci
```

## Data Maintenance

The following scripts overwrite existing metas, so run the dry-run variants first and review the diff before committing.

### Update Plonk It metas

```bash
npm run scrape:dry-run
npm run scrape
```

This keeps existing data and IDs where possible, adds new Plonk It metas, removes obsolete `imageLink` fields, and keeps location links intact through canonical meta IDs:

- Plonk It metas: `meta_<country_slug>_<plonkitId>`
- local retained metas: `meta_<country_slug>_local_<suffix>`

### Extract linked locations

```bash
npm run locations:plonkit:dry-run
npm run locations:plonkit
```

This reads Google Maps links from the Plonk It guide data, resolves coordinates, reverse-geocodes them with Nominatim, and writes the links to `data/plonkit_locations.json`. The extractor is rate-limited, so a full run can take a while.

Optionally recompute tags and scopes with the JS enrichment scripts:

```bash
npm run enrich:tags:dry-run
npm run enrich:scopes:dry-run
npm run enrich:tags
npm run enrich:scopes
```

### Generate missing titles

```bash
npm run enrich:titles
```

By default this uses local Ollama (`gemma4:e2b`) and only fills missing titles. To use another local model:

```bash
node scripts/generate_titles_ai.js --model=qwen3.5:2b
```

To regenerate all titles, add `--force`, but treat that as a review workflow rather than a blind update. Existing curated titles are often better than model rewrites. For regular updates, prefer the default non-force mode.

### Run the regular update pipeline

```bash
npm run update:plonkit
```

This command runs the scraper, linked-location extractor, and missing-title generator. Tag and scope enrichment remain separate review steps.

### Validation

Check the userscript syntax locally without executing it:

```bash
node --check geoguessr-meta.user.js
```

For a non-writing live scraper smoke test, run:

```bash
npm run scrape:test
```

## Data, Permissions, and Network Access

- BetterMetas runs only on `https://www.geoguessr.com/*` and reads the current game state to identify locations.
- It downloads userscript and metadata updates from the official GitHub repository and may query Nominatim for reverse geocoding.
- Preferences, cached data, and an optional maintainer token are stored in the browser profile. The token is not required for normal use or community issue submissions.
- A configured maintainer token can write directly to repository data through the GitHub API. Use a narrowly scoped token and never share or commit it.
- Community submissions without a token are reviewed through GitHub Issues before they become part of the data set.

## Tech Stack

| Layer              | Technology             | Version |
| :----------------- | :--------------------- | :------ |
| **Userscript**     | JavaScript / Tampermonkey metadata | 0.7 |
| **Data Tooling**   | Node.js                | 18+     |
| **Services**       | GitHub API, Nominatim  | -       |
| **Knowledge Base** | Plonk It               | -       |

## Credits

BetterMetas is built using the following projects and resources:

- **[Plonk It](https://www.plonkit.net)**: For the incredibly detailed Geoguessr guides that serve as the basis for much of the data.
- **[Nominatim / OpenStreetMap](https://nominatim.org/)**: For providing high-precision geodata and reverse geocoding.
- **[Google Maps Platform](https://mapsplatform.google.com/)**: For additional location data.

## License

This project is proprietary source-available software protected by copyright law. Private, personal, educational, and informational use is permitted only under the conditions in [LICENSE](LICENSE); redistribution and commercial use require prior written permission.

Persona Non Grata:
Daniel Harzbecker is expressly and unconditionally excluded from any license or permission to use this software. Any access, use, or reproduction by this individual does not constitute a license and shall be deemed a willful infringement of intellectual property rights.

Third-party services and source material remain subject to their respective rights and applicable license terms.

Copyright (c) 2026 Lukas Harzbecker. All Rights Reserved.
