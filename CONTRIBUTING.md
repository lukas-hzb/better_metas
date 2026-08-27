# Contributing to BetterMetas

Bug reports, focused feature proposals, and sourced meta corrections are welcome. Because BetterMetas is proprietary source-available software, obtain prior written authorization from the maintainer before creating a public fork or submitting a code pull request.

## Documentation and Commands

Keep [README.md](README.md) focused on installing and using the userscript. Local setup, testing, troubleshooting, and repository commands belong in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Scraping, enrichment, data review, and maintainer operations belong in [docs/DATA_MAINTENANCE.md](docs/DATA_MAINTENANCE.md).

Extend the relevant guide instead of duplicating command sequences in the README or this file. Credentials and personal operational notes must remain outside the repository.

## Report a Bug or Propose a Feature

Search [existing issues](https://github.com/lukas-hzb/better_metas/issues) before opening a new one. For a bug report, include:

- The userscript version, browser, and userscript manager
- The game mode and whether the problem occurs on a round-result screen
- Reproduction steps, expected behavior, and actual behavior
- Relevant screenshots or console errors with tokens, private game links, and account information removed

For a feature proposal, describe the user problem, expected workflow, and alternatives considered. Questions about normal use may also be raised in an issue. Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public bug report.

## Suggest a Meta or Location Correction

Use the HUD's **Add** dialog for a new clue or a link to an existing meta. Without a token, it opens a pre-filled GitHub issue; a GitHub account is needed to submit it. Verify the location, meta IDs, description, and geographic scope before submitting. Add a source link and explain why the clue applies at that location.

For a correction to an existing clue or removal of an incorrect link, open an ordinary issue describing the affected meta and location. The current issue automation does not support unlink submissions.

Only provide text and images you have permission to contribute. Link to third-party sources instead of assuming their content can be redistributed. Do not include credentials or private account information in the generated JSON, screenshots, or issue text.

The existing issue workflow can apply supported submissions directly to `main_v4` without human approval. Opening or editing an automatically generated submission may trigger processing; do not use live issues to test payloads or assume that a closed issue proves a manual review occurred.

## Submit an Authorized Change

1. Obtain written authorization for the proposed contribution and any public fork.
2. Create a focused branch from the latest `main_v4`.
3. Follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup and checks.
4. Keep code changes separate from bulk data refreshes, and describe how you tested the change.
5. Use concise English [Conventional Commits](https://www.conventionalcommits.org/), for example `docs: clarify userscript installation`.
6. Open a pull request explaining the problem, the change, and any remaining limitations.

Do not commit credentials, browser-profile exports, logs, or personal operational notes. Data changes must preserve stable meta IDs and valid location references.

## Known Limitations

- HUD visibility depends on GeoGuessr's result-page structure; a site update or an unrecognized game mode can prevent detection.
- Geographic matching is heuristic. A predicted clue is not proof that it applies, and guide data or reverse-geocoded addresses may be incomplete or outdated.
- The browser caches data, so repository changes may not appear immediately. The settings screenshots also show some older control labels.
- Community issue processing has no mandatory review gate, does not handle unlink submissions, and can mishandle zero-valued coordinates. These require implementation changes; this documentation does not imply they are fixed.
- Maintainer credentials are currently stored in page-accessible storage. See the [token precautions](docs/DATA_MAINTENANCE.md#maintainer-tokens-and-direct-writes).
- The repository has no general automated test suite or general CI workflow yet. Syntax checks and manual browser checks do not establish full compatibility or security.

## Contribution Terms

By submitting a contribution, you agree to section 5 of [LICENSE](LICENSE), including its contributor grant and representations. Third-party material must be identified and compatible with the contribution terms and intended distribution.
