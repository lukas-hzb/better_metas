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

|                                  Main HUD Preview                                  |                                   Predicted Metas                                   |
| :-------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------: |
| <img src="images/hud_preview.png" alt="Main HUD" width="400" /> | <img src="images/hud_preview_2.png" alt="Predicted Metas" width="400" /> |

|                                  Add Meta Dialog                                  |                                   Settings Menu                                   |
| :-------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------: |
| <img src="images/add_meta_dialog.png" alt="Add Meta" width="400" /> | <img src="images/settings_menu.png" alt="Settings" width="400" /> |

## Installation

### Browser Setup

Since this is a specific Userscript, you need a Userscript manager for your browser.

1. Install the **Tampermonkey** browser extension (available for Chrome, Firefox, Edge, Safari).
2. **[Click here to install the script](https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v3/geoguessr-meta.user.js)**.
3. Tampermonkey will ask if you want to add the script. Confirm by clicking "Install".
4. Open Geoguessr and start a game – the HUD should appear automatically.

## Tech Stack

| Layer              | Technology  | Version |
| :----------------- | :---------- | :------ |
| **Frontend**  | Userscript (JS)       | -   |
| **Data Scraper** | Node.js      | 1.0.0    |
| **APIs** | Google Maps, Nominatim  | -       |
| **Knowledge Base**      | Plonk It  | -   |

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
