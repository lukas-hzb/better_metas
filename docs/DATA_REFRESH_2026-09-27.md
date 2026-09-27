# Plonk It Refresh — 2026-09-27

Compared all 136 current [Plonk It guides](https://www.plonkit.net/guide) with the repository data. The [detailed audit](reports/plonkit-refresh-2026-09-27.json) records every changed field, retained meta, missing primary location link, and unreviewed text link.

## Results

- **5539 metas**; 44 entries changed, including 13 warning-markup cleanups. No new meta IDs were needed.
- **4944 unique locations**, up from 3,073: **1871 added**.
- **4797 metas** now have a location; **742** do not.
- **277 existing metas** absent from the current guide import were retained. They were not silently removed or assigned new IDs.
- Two titles were corrected after reviewing changed source text: “Cook Pines” and “Arthur's Pass Riverbed”. Other titles, all existing scopes, and all tags were preserved.

## Primary Image Links

| Outcome | Guide tips |
| :------ | ---------: |
| linked | 4654 |
| non_maps_link | 538 |
| no_link | 67 |
| no_parseable_panorama | 3 |

The three unparseable links are Liechtenstein tips: they open coordinate-based Street View URLs without a panorama ID. No panorama ID was guessed. Most newly recovered locations came from valid links that were absent from the previous location database, rather than from a new URL format.

There are also **1840 text-link candidates** across 1131 tips after deduplication within each tip and exclusion of the identical primary link. These may include comparisons and counterexamples from other countries. They are listed for review, not automatically added as evidence for a clue.

## Preservation and Verification

- Both community files are byte-for-byte identical to the saved baseline.
- Every original meta ID, panorama-to-meta link, coordinate, address field, and other existing location field remains present and unchanged.
- No duplicate meta IDs or dangling location references; all stored coordinates are in bounds.
- Twelve merge/parser regression tests pass. Replaying the meta snapshot produces zero further changes; replaying the location import in dry-run mode adds zero locations.
- README statistics were regenerated.

## Limits

New locations contain panorama IDs, coordinates, and the source guide's country. New reverse geocoding was not run, so their region/city/road fields remain empty; existing address data was preserved.

Eight changed image URLs were taken directly from the source guides. HEAD requests returned HTTP 403, so their image availability could not be independently verified.
