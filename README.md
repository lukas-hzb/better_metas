# BetterMetas

BetterMetas is a powerful Userscript for Geoguessr that helps you recognize and learn metas and hints directly in the game. It combines a huge database (based on Plonk It) with smart location predictions to eliminate the need of classyfying every single location.

## Features

- **Live HUD**: Automatically displays relevant hints, tags, and images for your current location.
- **Smart Predictions**: The script analyzes your location (country, region, city, road) and suggests metas that might apply here – not just exact matches, but also based on geography and "scopes" (e.g., 10km radius, regional, countrywide).
- **Plonk It Integration**: Includes thousands of entries from the detailed Plonk It guides.
- **Location Info**: Shows you precise address data, coordinates, and region names (powered by Google & Nominatim).
- **Crowdsourcing**: Add your own metas or link existing metas to new locations to improve the database.
- **Filters**: Customize which types of hints you want to see (e.g., only "Unique" or also "Countrywide").

### Screenshots

| Main HUD Preview                                                | Predicted Metas                                                          |
| :-------------------------------------------------------------: | :----------------------------------------------------------------------: |
| <img src="images/hud_preview.png" alt="Main HUD" width="400" /> | <img src="images/hud_preview_2.png" alt="Predicted Metas" width="400" /> |

| Add Meta Dialog                                                     | Settings Menu                                                     |
| :-----------------------------------------------------------------: | :---------------------------------------------------------------: |
| <img src="images/add_meta_dialog.png" alt="Add Meta" width="400" /> | <img src="images/settings_menu.png" alt="Settings" width="400" /> |

## Installation

### Browser Setup

Since this is a specific Userscript, you need a Userscript manager for your browser.

1. Install the **Tampermonkey** browser extension (available for Chrome, Firefox, Edge, Safari).
2. **[Click here to install the script](https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v3/geoguessr-meta.user.js)**.
3. Tampermonkey will ask if you want to add the script. Confirm by clicking "Install".
4. Open Geoguessr and start a game – the HUD should appear automatically.

### Development Setup

The data pipeline is Node.js based and does not require Python. Install npm metadata once:

```bash
npm install
```

## Usage

### Scraping Metas, their Locations, and generating new Titles

Use the dry-runs before writing data:

```bash
npm run scrape:dry-run
npm run locations:plonkit:dry-run
npm run enrich:tags:dry-run
npm run enrich:scopes:dry-run
```

Update Plonk It metas from the live guide pages:

```bash
npm run scrape
```

This keeps existing data and IDs where possible, adds new Plonk It metas, removes obsolete `imageLink` fields, and keeps location links intact through canonical meta IDs:

- Plonk It metas: `meta_<country_slug>_<plonkitId>`
- local retained metas: `meta_<country_slug>_local_<suffix>`

Extract Google Maps-linked Plonk It locations:

```bash
npm run locations:plonkit
```

This reads Google Maps links from the Plonk It guide data, resolves coordinates, reverse-geocodes them with Nominatim, and writes the links to `data/plonkit_locations.json`. The extractor is rate-limited, so a full run can take a while.

Optionally recompute tags and scopes with the JS enrichment scripts:

```bash
npm run enrich:tags
npm run enrich:scopes
```

These scripts overwrite the `tags` or `scope` fields in `data/plonkit_metas.json`, so run the dry-run variants first and review the diff before committing.

Generate titles for metas that do not have one yet:

```bash
npm run enrich:titles
```

By default this uses local Ollama (`gemma4:e2b`) and only fills missing titles. To use another local model:

```bash
node scripts/generate_titles_ai.js --model=qwen3.5:0.8b
```

To regenerate all titles, add `--force`, but treat that as a review workflow, not a blind update. Existing curated titles are often better than model rewrites. For regular updates, prefer the default non-force mode.

Run the regular update pipeline:

```bash
npm run update:plonkit
```

## Tech Stack

| Layer              | Technology             | Version |
| :----------------- | :--------------------- | :------ |
| **Frontend**       | Userscript (JS)        | -       |
| **Data Scraper**   | Node.js                | 1.0.0   |
| **APIs**           | Google Maps, Nominatim | -       |
| **Knowledge Base** | Plonk It               | -       |

## Credits

BetterMetas is built using the following projects and resources:

- **[Plonk It](https://www.plonkit.net)**: For the incredibly detailed Geoguessr guides that serve as the basis for much of the data.
- **[Nominatim / OpenStreetMap](https://nominatim.org/)**: For providing high-precision geodata and reverse geocoding.
- **[Google Maps Platform](https://mapsplatform.google.com/)**: For additional location data.

## License

This project is proprietary software protected by international copyright law.

Persona Non Grata:
Daniel Harzbecker is expressly and unconditionally excluded from any license or permission to use this software. Any access, use, or reproduction by this individual does not constitute a license and shall be deemed a willful infringement of intellectual property rights.

Third-Party Rights:
The Licensor waives ownership claims over third-party contributions and community modifications, respecting the intellectual property of external contributors.

For full legal terms, see [LICENSE](LICENSE).

Copyright (c) 2026 Lukas Harzbecker. All Rights Reserved.