const path = require('path');
const { getLowerCaseArg, parseIntArg } = require('./scripts/cli_utils');
const { readJson, stringifyJsonAscii, writeJsonAscii } = require('./scripts/json_utils');
const {
    BASE_URL,
    extractPreloadedData,
    fetchText,
    scrapeGuideIndex,
    stableMetaId,
} = require('./scripts/plonkit_utils');
const PLONKIT_METAS_PATH = path.join(__dirname, 'data/plonkit_metas.json');
const TODAY_ISO_DATE = new Date().toISOString().slice(0, 10);

const TAG_MAP = {
    'architecture': 'architecture',
    'bollard': 'bollards',
    'bollards': 'bollards',
    'camera': 'camera',
    'chevron': 'signs',
    'chevron/sign': 'signs',
    'coverage': 'camera',
    'guardrail': 'road',
    'landscape': 'landscape',
    'language': 'language',
    'license plates': 'plates',
    'licence plates': 'plates',
    'plate': 'plates',
    'plates': 'plates',
    'pole': 'poles',
    'poles': 'poles',
    'road': 'road',
    'roadline': 'road',
    'sign': 'signs',
    'signs': 'signs',
};

function usage() {
    console.log(`Usage: node scraper.js [--test] [--dry-run] [--country=slug-or-name] [--limit=N]

Options:
  --test            Scrape one recent country, print JSON, do not write.
  --dry-run         Scrape and compare against local data, do not write.
  --country=value   Restrict scraping to a Plonkit slug or country title.
  --limit=N         Restrict the number of countries scraped.
`);
}

function parseArgs(argv) {
    const args = {
        test: argv.includes('--test'),
        dryRun: argv.includes('--dry-run'),
        help: argv.includes('--help') || argv.includes('-h'),
        country: getLowerCaseArg(argv, '--country='),
        limit: parseIntArg(argv, '--limit='),
    };
    return args;
}

function toAbsoluteUrl(url) {
    if (!url) return null;
    return new URL(url, BASE_URL).toString();
}

function stripMarkdown(text) {
    return String(text || '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitTextAndNote(textParts) {
    const parts = (textParts || [])
        .map(stripMarkdown)
        .filter(Boolean);

    const descriptionParts = [];
    const noteParts = [];

    for (const part of parts) {
        if (/^NOTE:/i.test(part)) {
            noteParts.push(part.replace(/^NOTE:\s*/i, '').trim());
        } else {
            descriptionParts.push(part);
        }
    }

    return {
        description: descriptionParts.join('\n'),
        note: noteParts.join('\n'),
    };
}

function normalizeForMatch(value) {
    return stripMarkdown(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function stableLocalMetaId(slug, meta) {
    const canonicalPrefix = stableMetaId(slug, 'local');
    if (String(meta.id || '').startsWith(`${canonicalPrefix}_`)) return meta.id;

    const randomSuffix = String(meta.id || '').match(/^meta_\d+_([a-z0-9]+)$/i)?.[1];
    const suffix = randomSuffix || simpleHash(`${meta.id || ''}|${meta.title || ''}|${meta.description || ''}`);
    return stableMetaId(slug, `local_${suffix}`);
}

function simpleHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function fallbackScopeForSection(section) {
    const stepNumber = Number.parseInt(String(section).replace('Step ', ''), 10);
    if (stepNumber === 2) return 'region';
    if (stepNumber >= 3) return '10km';
    return 'countrywide';
}

function convertTags(tags) {
    const converted = new Set();
    for (const rawTag of tags || []) {
        const mapped = TAG_MAP[String(rawTag).toLowerCase()];
        if (mapped) converted.add(mapped);
    }
    return [...converted];
}

function orderMetaFields(meta) {
    const ordered = {};
    for (const key of [
        'id',
        'plonkitId',
        'country',
        'section',
        'title',
        'description',
        'note',
        'imageUrl',
        'scope',
        'tags',
        'addedAt',
    ]) {
        if (Object.prototype.hasOwnProperty.call(meta, key)) ordered[key] = meta[key];
    }
    return ordered;
}

function orderCountryFields(country) {
    return {
        country: country.country,
        slug: country.slug,
        code: country.code,
        categories: country.categories,
        url: country.url,
        updatedAt: country.updatedAt,
        metas: (country.metas || []).map(orderMetaFields),
    };
}

function flattenGuideItems(countryData) {
    const guide = countryData.public || countryData;
    const metas = [];

    for (const [stepIndex, step] of (guide.steps || []).entries()) {
        if (!Array.isArray(step.items)) continue;

        const section = `Step ${stepIndex + 1}`;
        for (const item of step.items) {
            if (item.kind !== 'tip' || !item.id || !item.data) continue;

            const text = splitTextAndNote(item.data.text || []);
            if (!text.description) continue;

            const imageUrl = toAbsoluteUrl(item.data.image?.imageUrl);
            metas.push(orderMetaFields({
                id: stableMetaId(guide.slug, item.id),
                plonkitId: item.id,
                country: guide.title,
                section,
                title: '',
                description: text.description,
                note: text.note,
                imageUrl,
                scope: fallbackScopeForSection(section),
                tags: convertTags(item.tags),
                addedAt: TODAY_ISO_DATE,
            }));
        }
    }

    return orderCountryFields({
        country: guide.title,
        slug: guide.slug,
        code: guide.code || null,
        categories: guide.cat || [],
        url: `${BASE_URL}/${guide.slug}`,
        updatedAt: guide.updatedAt || null,
        metas,
    });
}

async function scrapeCountry(slug) {
    const url = `${BASE_URL}/${slug}`;
    const html = await fetchText(url, {
        'User-Agent': 'BetterMetasScraper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
    });
    return flattenGuideItems(extractPreloadedData(html, url));
}

function loadExistingData() {
    return readJson(PLONKIT_METAS_PATH, []);
}

function buildCountryLookup(existingData) {
    const bySlug = new Map();
    const byCountry = new Map();
    const lookup = { bySlug, byCountry };

    for (const entry of existingData) {
        addCountryToLookup(lookup, entry);
    }

    return lookup;
}

function addCountryToLookup(lookup, entry) {
    if (entry.slug) lookup.bySlug.set(String(entry.slug).toLowerCase(), entry);
    if (entry.country) lookup.byCountry.set(String(entry.country).toLowerCase(), entry);
    if (entry.url) {
        const slug = entry.url.split('/').filter(Boolean).pop();
        if (slug) lookup.bySlug.set(slug.toLowerCase(), entry);
    }
}

function removeCountryFromLookup(lookup, entry) {
    for (const map of Object.values(lookup)) {
        for (const [key, value] of map) {
            if (value === entry) map.delete(key);
        }
    }
}

function findExistingCountry(lookup, scrapedCountry) {
    return lookup.bySlug.get(scrapedCountry.slug.toLowerCase())
        || lookup.byCountry.get(scrapedCountry.country.toLowerCase())
        || null;
}

function buildMetaLookup(existingMetas) {
    const lookup = {
        byPlonkitId: new Map(),
        byStableId: new Map(),
        byImage: new Map(),
        byDescription: new Map(),
    };

    for (const meta of existingMetas) {
        if (meta.plonkitId && !lookup.byPlonkitId.has(meta.plonkitId)) lookup.byPlonkitId.set(meta.plonkitId, meta);
        if (!lookup.byStableId.has(meta.id)) lookup.byStableId.set(meta.id, meta);
        if (meta.imageUrl) {
            const imagePath = new URL(meta.imageUrl).pathname;
            if (!lookup.byImage.has(imagePath)) lookup.byImage.set(imagePath, meta);
        }
        const description = normalizeForMatch(meta.description);
        if (!lookup.byDescription.has(description)) lookup.byDescription.set(description, meta);
    }

    return lookup;
}

function findExistingMeta(lookup, scrapedMeta) {
    const byPlonkitId = scrapedMeta.plonkitId && lookup.byPlonkitId.get(scrapedMeta.plonkitId);
    if (byPlonkitId) return byPlonkitId;

    const byStableId = lookup.byStableId.get(scrapedMeta.id);
    if (byStableId) return byStableId;

    const imagePath = scrapedMeta.imageUrl ? new URL(scrapedMeta.imageUrl).pathname : '';
    const byImage = imagePath && lookup.byImage.get(imagePath);
    if (byImage) return byImage;

    return lookup.byDescription.get(normalizeForMatch(scrapedMeta.description)) || null;
}

function mergeMeta(existingMeta, scrapedMeta) {
    if (!existingMeta) return scrapedMeta;

    const merged = {
        ...existingMeta,
        id: scrapedMeta.plonkitId ? scrapedMeta.id : existingMeta.id,
        country: scrapedMeta.country,
        section: scrapedMeta.section,
        description: scrapedMeta.description,
        note: scrapedMeta.note,
        imageUrl: scrapedMeta.imageUrl || existingMeta.imageUrl || null,
        plonkitId: existingMeta.plonkitId || scrapedMeta.plonkitId,
        addedAt: existingMeta.addedAt || scrapedMeta.addedAt || TODAY_ISO_DATE,
    };
    delete merged.imageLink;

    if (!merged.title && scrapedMeta.title) merged.title = scrapedMeta.title;
    if (!merged.scope) merged.scope = scrapedMeta.scope;
    if (!Array.isArray(merged.tags) || merged.tags.length === 0) merged.tags = scrapedMeta.tags;

    return orderMetaFields(merged);
}

function mergeCountry(existingCountry, scrapedCountry, stats) {
    const existingMetas = existingCountry?.metas || [];
    const existingMetaLookup = buildMetaLookup(existingMetas);
    const usedExisting = new Set();
    const mergedMetas = [];

    for (const scrapedMeta of scrapedCountry.metas) {
        const existingMeta = findExistingMeta(existingMetaLookup, scrapedMeta);
        if (existingMeta) {
            usedExisting.add(existingMeta);
            mergedMetas.push(mergeMeta(existingMeta, scrapedMeta));
            stats.updated += 1;
        } else {
            mergedMetas.push(scrapedMeta);
            stats.added += 1;
        }
    }

    for (const existingMeta of existingMetas) {
        if (!usedExisting.has(existingMeta)) {
            const localOnlyMeta = { ...existingMeta };
            if (!localOnlyMeta.plonkitId) localOnlyMeta.id = stableLocalMetaId(scrapedCountry.slug, localOnlyMeta);
            delete localOnlyMeta.imageLink;
            mergedMetas.push(orderMetaFields(localOnlyMeta));
            stats.keptLocalOnly += 1;
        }
    }

    return orderCountryFields({
        ...(existingCountry || {}),
        country: scrapedCountry.country,
        slug: scrapedCountry.slug,
        code: scrapedCountry.code,
        categories: scrapedCountry.categories,
        url: scrapedCountry.url,
        updatedAt: scrapedCountry.updatedAt,
        metas: mergedMetas,
    });
}

function mergeScrapedData(existingData, scrapedData) {
    const stats = {
        countriesAdded: 0,
        countriesUpdated: 0,
        added: 0,
        updated: 0,
        keptLocalOnly: 0,
    };

    const output = [...existingData];
    const countryLookup = buildCountryLookup(output);

    for (const scrapedCountry of scrapedData) {
        const existingCountry = findExistingCountry(countryLookup, scrapedCountry);
        const mergedCountry = mergeCountry(existingCountry, scrapedCountry, stats);

        if (existingCountry) {
            const index = output.indexOf(existingCountry);
            output[index] = mergedCountry;
            removeCountryFromLookup(countryLookup, existingCountry);
            stats.countriesUpdated += 1;
        } else {
            output.push(mergedCountry);
            stats.countriesAdded += 1;
        }
        addCountryToLookup(countryLookup, mergedCountry);
    }

    return { data: output, stats };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }

    const guideEntries = await scrapeGuideIndex({
        'User-Agent': 'BetterMetasScraper/1.0 (+https://github.com/)',
        'Accept': 'text/html,application/xhtml+xml',
    });
    console.log(`Found ${guideEntries.length} Plonkit guide entries.`);

    let targets = guideEntries;
    if (args.country) {
        targets = guideEntries.filter((entry) => (
            entry.slug.toLowerCase() === args.country
            || entry.title.toLowerCase() === args.country
        ));
        if (targets.length === 0) throw new Error(`No guide entry matched --country=${args.country}`);
    }

    if (args.test && !args.country) {
        targets = [...guideEntries]
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .slice(0, 1);
    }

    if (Number.isInteger(args.limit) && args.limit > 0) {
        targets = targets.slice(0, args.limit);
    }

    const scrapedData = [];
    for (const [index, entry] of targets.entries()) {
        console.log(`[${index + 1}/${targets.length}] Scraping ${entry.title} (${entry.slug})...`);
        scrapedData.push(await scrapeCountry(entry.slug));
    }

    if (args.test) {
        console.log(stringifyJsonAscii(scrapedData));
        return;
    }

    const existingData = loadExistingData();
    const { data, stats } = mergeScrapedData(existingData, scrapedData);

    console.log(`Countries updated: ${stats.countriesUpdated}`);
    console.log(`Countries added: ${stats.countriesAdded}`);
    console.log(`Metas added: ${stats.added}`);
    console.log(`Metas refreshed from Plonkit: ${stats.updated}`);
    console.log(`Local-only metas kept: ${stats.keptLocalOnly}`);

    if (args.dryRun) {
        console.log('Dry run: no files written.');
        return;
    }

    writeJsonAscii(PLONKIT_METAS_PATH, data);
    console.log(`Saved merged data to ${PLONKIT_METAS_PATH}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exitCode = 1;
    });
}

module.exports = {
    convertTags,
    mergeScrapedData,
};
