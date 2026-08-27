# BetterMetas Data Maintenance

These commands are for authorized contributors and maintainers, not ordinary userscript installation. Complete [development setup](DEVELOPMENT.md) first and run commands from the repository root. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) when preparing changes.

## Before You Run a Pipeline

Start with a clean working tree or separately saved work. Writing runs overwrite JSON files and some save intermediate checkpoints. Preview a limited run first, inspect its output, and review the resulting diff before committing.

**Dry-run means no file writes, not necessarily no network access or cost.** Scraper and location-extractor previews still contact external services. Title previews still call the selected model provider. Only the tag and scope previews are entirely local.

## Data Files and Stable IDs

| File | Purpose |
| :--- | :------ |
| [`data/plonkit_metas.json`](../data/plonkit_metas.json) | Country groups containing Plonk It-derived metas |
| [`data/user_metas.json`](../data/user_metas.json) | Flat array of community metas |
| [`data/plonkit_locations.json`](../data/plonkit_locations.json) | Panorama-to-meta links and location metadata extracted from guides |
| [`data/user_locations.json`](../data/user_locations.json) | Community panorama-to-meta links and location metadata |

Plonk It meta IDs use `meta_<country_slug>_<plonkitId>`. Locally retained entries use `meta_<country_slug>_local_<suffix>`; userscript-created entries use a timestamp and random suffix. Preserve existing IDs and check both location maps when a meta changes. Never regenerate IDs merely to reformat or retitle a clue.

Location-map entries normally contain `metas`, coordinates, and address fields. The userscript also accepts legacy arrays of meta IDs. Treat numeric zero as a valid coordinate, not a missing value. Keep absent location information distinct from an actual coordinate or address.

## Refresh Plonk It Metas

Preview one country or the full import:

```sh
npm run scrape:dry-run -- --country=kenya
npm run scrape:dry-run
```

To write the full merge after reviewing the preview:

```sh
npm run scrape
```

The importer merges guide entries with existing data, retains local-only entries where possible, uses canonical IDs, and removes obsolete `imageLink` fields. Check IDs and location references after a refresh rather than assuming every upstream change can be matched correctly.

For a non-writing live smoke test that fetches a recent country and prints JSON:

```sh
npm run scrape:test
```

The scraper also supports `--limit=N` for the number of countries and `--help` for its options.

## Extract Linked Locations

Preview before writing:

```sh
npm run locations:plonkit:dry-run -- --country=kenya
```

To update all linked locations:

```sh
npm run locations:plonkit
```

The extractor reads Plonk It guides, resolves Google Maps links, and uses Nominatim for reverse geocoding before updating `data/plonkit_locations.json`. It reuses existing location information where possible and spaces Nominatim requests by at least 1.2 seconds within a run. `--limit=N` limits countries, not individual locations.

Review Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) before bulk use. Avoid parallel or distributed runs and retain cached results. Scheduled jobs and runs lasting longer than a day are limited to four requests per minute; the current extractor's delay does not enforce that stricter limit. Do not schedule this pipeline unchanged or assume its default delay establishes compliance.

## Recompute Tags and Scopes

These heuristic enrichment steps replace the corresponding fields in `data/plonkit_metas.json`. They are separate from the regular update pipeline and may overwrite curated values.

```sh
npm run enrich:tags:dry-run
npm run enrich:scopes:dry-run
```

After reviewing the previews, run only the desired writing step:

```sh
npm run enrich:tags
npm run enrich:scopes
```

Both support `--country=slug-or-name`, passed after npm's `--` separator.

## Generate Missing Titles

The title generator defaults to a local Ollama server at `http://127.0.0.1:11434`, using `gemma4:e2b` unless `OLLAMA_MODEL` or `--model` selects another model. Start Ollama and make the selected model available before running it.

Preview a small batch without writing, then generate missing titles if the output is suitable:

```sh
node scripts/generate_titles_ai.js --dry-run --limit=5
npm run enrich:titles
```

To use another locally available model:

```sh
node scripts/generate_titles_ai.js --model=qwen3.5:2b
```

Existing titles are skipped unless `--force` is supplied. Use `--force` only for an intentional, reviewed rewrite. `--country=slug-or-name` and `--limit=N` restrict the selected metas; `--save-every=N` controls checkpoint frequency on writing runs.

The script also has an optional external provider selected through `--provider` or `TITLE_PROVIDER`. Review its implementation and credential requirements before use: prompts include the clue's country, section, title, description, and note. Changing `OLLAMA_BASE_URL` can also send those prompts to a remote server. A dry-run still sends prompts and can incur provider charges. Keep API credentials out of committed files and logs.

## Run the Regular Update Pipeline

```sh
npm run update:plonkit
```

This is a writing command. It runs the scraper, linked-location extractor, and missing-title generator in sequence. It does not run tag or scope enrichment and is not an offline validation command. Check stage output and the final diff; title generation can report individual failures without failing the whole process.

## Review Before Publishing

- Check JSON syntax, expected top-level shapes, unique meta IDs, and references from both location files.
- Check coordinate bounds, nullable fields, source links, geographic scope, and generated titles.
- Review unrelated deletions, large rewrites, and encoding changes. The shared JSON writer uses two-space indentation and ASCII escapes for non-ASCII characters.
- Run the [development checks](DEVELOPMENT.md#edit-and-check-the-userscript) and review `git diff --check` and `git diff --stat`.
- Keep a bulk data refresh separate from code or documentation changes. Use an English Conventional Commit describing the actual update.

## Maintainer Tokens and Direct Writes

Ordinary users need no GitHub token. A token configured in the current Settings panel can edit the official repository directly. It is stored in GeoGuessr's page-accessible `localStorage` and copied into the page's settings input; it is not isolated from page scripts. Prefer leaving the field empty and reviewing repository-side edits until credential handling is hardened.

If you already use this feature, use a short-lived, narrowly scoped credential restricted to the required repository, never share it, and revoke it if exposure is suspected. Clearing the Settings field and saving removes the saved value for that browser origin but does not revoke the credential on GitHub. Do not put credentials in screenshots, issues, shell history, or committed files.

**Delete Saved User Data** clears the shared user-meta and user-location data through the GitHub API; it does not merely clear a local browser cache. Do not use it for troubleshooting or routine testing.
