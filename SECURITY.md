# Security Policy

## Scope

Please reproduce suspected problems against the current official userscript on `main_v4`. Reports should identify the affected version or commit; older branches, private modifications, and third-party copies may behave differently.

Relevant reports include exposed maintainer tokens, unsafe repository writes, injection through meta content, and unintended disclosure of game or account data. Problems confined to a third-party service should be reported to that provider.

## Report a Vulnerability

Check the repository's [Security tab](https://github.com/lukas-hzb/better_metas/security). If **Report a vulnerability** is available, use that private form. Otherwise, open a neutral [private-contact request](https://github.com/lukas-hzb/better_metas/issues/new?title=Private%20security%20contact%20requested) asking the maintainer to arrange a confidential channel. The contact request itself is public: do not include vulnerability details there.

Do not disclose working exploits, tokens, private game links, browser-profile contents, or personal data in public issues. Once a private channel is established, provide reproduction steps, the affected feature, expected impact, and any suggested mitigation.

Test only with accounts and data you own or are explicitly authorized to use. Do not test submission handling against the live issue workflow: it can modify shared repository data. Coordinate disclosure with the maintainer; no response-time commitment is made.

## Credential Precautions

Normal use and community submissions need no GitHub token. The current maintainer feature does not isolate its token from the GeoGuessr page. Follow the [maintainer-token notes](docs/DATA_MAINTENANCE.md#maintainer-tokens-and-direct-writes); revoke any token suspected of exposure and never include the token itself in a report.
