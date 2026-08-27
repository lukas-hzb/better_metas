<h1 align="center">BetterMetas</h1>

<p align="center">
  BetterMetas is a GeoGuessr userscript that displays relevant metas and hints directly in-game, using a large Plonk It–based database and smart location predictions to eliminate the need for manual location classification.
</p>

Study location clues on GeoGuessr's round-result screens, with descriptions, images, and geographic context in one overlay. BetterMetas is distributed as a userscript; there is no separate website or hosted application.

## Features

- **Result-screen HUD** — Displays relevant hints, tags, and images while reviewing a completed round.
- **Geographic matching** — Suggests metas using country, region, city, road, distance, and configured scopes instead of relying only on exact panorama matches.
- **Plonk It integration** — Includes structured entries derived from the detailed Plonk It guides.
- **Location context** — Uses available panorama coordinates and address information to match clues to the location.
- **Community contributions** — Opens a pre-filled GitHub issue for new metas or links to existing metas, without requiring a GitHub token.
- **Scope filters** — Controls which hints appear, from unique clues to countrywide patterns.

### Screenshots

| Result-screen HUD | Predicted Metas |
| :---------------: | :-------------: |
| <img src="images/hud_preview.png" alt="BetterMetas showing a snow-coverage clue on a GeoGuessr round-result screen" width="500" /> | <img src="images/hud_preview_2.png" alt="BetterMetas suggesting landscape and streetlight clues for a location in Brazil" width="500" /> |

| Add and Link Metas | Settings |
| :---------------: | :------: |
| <img src="images/add_meta_dialog.png" alt="BetterMetas dialog for searching, previewing, and linking metas to a location" width="500" /> | <img src="images/settings_menu.png" alt="BetterMetas settings with scope filters and optional maintainer controls" width="500" /> |

## Installation

1. Install a compatible userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. If your browser requires it, enable the manager's [permission to execute userscripts](https://www.tampermonkey.net/faq.php?locale=en&q=Q209).
3. Open the official [`geoguessr-meta.user.js`](https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v4/geoguessr-meta.user.js) installation URL.
4. Review the requested permissions, confirm installation, and reload [GeoGuessr](https://www.geoguessr.com/).

Normal use requires no Node.js installation, terminal commands, or GitHub token. Leave the optional token field in Settings empty.

The userscript's update metadata points to the official `main_v4` branch. Use your userscript manager's update check, or enable its automatic updates. Forks and copied files are not official update channels.

## Usage

1. Complete a GeoGuessr round and open its result screen; the HUD appears when BetterMetas recognizes that screen.
2. Review predicted metas, expand details, and filter scopes from the settings panel.
3. Use **Add** to search existing metas or describe a new clue. Without a maintainer token, a contribution opens a pre-filled GitHub issue. Check the proposed content before submitting it; see [CONTRIBUTING.md](CONTRIBUTING.md) for the current process.

BetterMetas is intended for learning from completed rounds. Follow [GeoGuessr's Community Rules](https://www.geoguessr.com/community-rules); result-screen visibility is not a guarantee of permission to use it in every game mode or competition.

## Data, Permissions, and Network Access

- BetterMetas runs only on `https://www.geoguessr.com/*` and reads the current game state to identify locations.
- Script updates and meta data come from GitHub. Location coordinates may be sent to Google Maps and Nominatim for reverse geocoding; clue images load from the hosts recorded in the data.
- Preferences and cached data are stored in the browser profile. Submitted GitHub issues make their panorama IDs, location details, and meta content public.
- Optional maintainer tokens enable direct repository writes. The current implementation stores them in page-accessible browser storage, not isolated userscript-manager storage. See the [maintainer notes](docs/DATA_MAINTENANCE.md#maintainer-tokens-and-direct-writes) before using this feature.

## Tech Stack

| Layer | Technology |
| :---- | :--------- |
| **Userscript** | JavaScript and userscript-manager APIs |
| **Data tooling** | Node.js; only needed for development and data maintenance |
| **Data storage** | JSON files in the repository and browser-side caches |
| **Services** | GitHub API, Google Maps, and Nominatim |
| **Knowledge base** | Plonk It guides and community contributions |

## Credits

BetterMetas is built using the following projects and resources:

- **[Plonk It](https://www.plonkit.net)**: For the incredibly detailed GeoGuessr guides that serve as the basis for much of the data.
- **[Nominatim / OpenStreetMap](https://nominatim.org/)**: For providing high-precision geodata and reverse geocoding.
- **[Google Maps Platform](https://mapsplatform.google.com/)**: For additional location data.

## Contributing

Bug reports, focused feature proposals, and sourced meta corrections are welcome. Code contributions and public forks require prior written authorization because BetterMetas is proprietary source-available software. See [CONTRIBUTING.md](CONTRIBUTING.md) for known limitations, the contribution process, and contribution terms. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

Development and test commands live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); scraper, enrichment, and maintainer commands live in [docs/DATA_MAINTENANCE.md](docs/DATA_MAINTENANCE.md).

## License

This project is proprietary source-available software protected by copyright law. Private, personal, educational, and informational use is permitted only under the conditions in [LICENSE](LICENSE); redistribution and commercial use require prior written permission.

Persona Non Grata:
Daniel Harzbecker is expressly and unconditionally excluded from any license or permission to use this software. Any access, use, or reproduction by this individual does not constitute a license and shall be deemed a willful infringement of intellectual property rights.

Third-party services and source material remain subject to their respective rights and applicable license terms.

Copyright (c) 2026 Lukas Harzbecker. All Rights Reserved.
