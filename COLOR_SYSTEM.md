# BetterMetas color system

Colors communicate meaning. A component keeps the same semantic color in the HUD, dialogs, lists, settings, and admin views.

## Semantic groups

| Meaning | Color | UI locations |
| --- | --- | --- |
| Primary action | Green | Save settings, link selected metas, link/select a meta, normal confirmations |
| Edit / GitHub PAT mode | Yellow | Manage Metas entry, Edit, Save Meta, Add another meta, Create/Save new meta, edit action in the meta dialog |
| Destructive action | Red outline | Delete saved user data, Delete Meta, Transfer Delete, transfer target action, unlink confirmations |
| Secondary / navigation | Neutral grey | Close, Cancel, Back, resize/reset controls, settings and other utility controls |
| Tag | Grey | Static tags in HUD, previews and lists; selectable tag presets and their selected state |
| Scope | Blue | Scope filter, scope presets, static scope in meta/admin lists; selected scopes stay blue |
| Linked status | Green badge | `LINKED` badge in the HUD and the already-linked indicator in selection lists |
| Predicted status | Grey badge | `PREDICTED` badge and predicted-row marker |
| Country code | Orange | Country abbreviation badge in meta/admin lists |

## Complete color inventory

### Actions

- HUD header: Manage Metas, Add, and Settings all use the same quiet neutral treatment so the metas remain dominant.
- Resize mode: Save/Reset/Close are utility controls. The purple resize frame is a temporary mode indicator, not an action color.
- Settings: Save Changes is green, Close and Resize Window are neutral, Delete Saved User Data has a red outline.
- Add/link dialog: Link Selected Metas is green; Add another meta and the final create/save action are yellow because they enter or perform PAT-backed authoring; Close and Back are neutral.
- Admin list/details: Edit and Save Meta are yellow; Delete Meta and Transfer Delete are red outlines; Close, Back, and Cancel are neutral.
- Confirmation/meta-action dialog: normal confirm/link is green, Edit is yellow, unlink/delete is a red outline, Cancel is neutral.

### Metadata and status

- Tags: `.gg-tag-static`, `.gg-tag-filter-pill` and their selected state are grey. Selected tag presets use only a stronger fill, bright border, and subtle shadow.
- Scopes: `.gg-scope-static`, `.gg-scope-pill` and their selected state are blue. Selected scopes use only a saturated blue fill, bright border, and subtle shadow. Scopes are never yellow or green.
- Linked: `.gg-meta-badge-linked` and `.gg-meta-linked-indicator` are green.
- Predicted: `.gg-meta-badge-predicted` and `.gg-meta-row-predicted` are grey.
- Countries: `.gg-country-badge` is orange.
- Location values: ordinary values are white; country text in the location box remains green as a highlighted location value; coordinates remain gold for scanability.

### Surfaces and structure

- HUD surface is translucent black; modal surfaces are dark blue/purple.
- Inputs, list containers, dividers, scrollbars, hints, disabled states, and empty states use neutral white/grey alpha values.
- Focus rings inherit the semantic color of the control: green for primary, yellow for edit/PAT, red for destructive, blue for scope, neutral for secondary.
- Resize mode uses purple/blue ambient decoration only while resizing.

## Implementation rule

New UI should use the semantic classes and tokens in `geoguessr-meta.user.js` rather than introducing a new literal color. In particular, do not use the generic selected state to turn tags or scopes green; combine it with `.gg-tag-filter-pill` or `.gg-scope-pill` so the selection remains within its semantic family.
