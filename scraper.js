const fs = require('fs');
const https = require('https');
const path = require('path');
const { stringifyJsonAscii } = require('./scripts/json_utils');

const BASE_URL = 'https://www.plonkit.net';
const GUIDE_URL = `${BASE_URL}/guide`;
const PLONKIT_METAS_PATH = path.join(__dirname, 'data/plonkit_metas.json');
const TODAY_ISO_DATE = new Date().toISOString().slice(0, 10);

const VALID_GUIDE_CATEGORIES = new Set([
    'Africa',
    'Antarctica',
    'Asia',
    'Europe',
    'North America',
    'Oceania',
    'South America',
]);

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
        country: null,
        limit: null,
    };

    const countryArg = argv.find((arg) => arg.startsWith('--country='));
    if (countryArg) args.country = countryArg.split('=').slice(1).join('=').trim().toLowerCase();

    const limitArg = argv.find((arg) => arg.startsWith('--limit='));
    if (limitArg) args.limit = Number.parseInt(limitArg.split('=')[1], 10);

    return args;
}

function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'BetterMetasScraper/1.0 (+https://github.com/)',
                'Accept': 'text/html,application/xhtml+xml',
            },
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, url).toString();
                res.resume();
                fetchText(nextUrl).then(resolve, reject);
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`GET ${url} failed with HTTP ${res.statusCode}`));
                return;
            }

            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

function extractPreloadedData(html, url) {
    const match = html.match(/<script id="__PRELOADED_DATA__" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
    if (!match) throw new Error(`No __PRELOADED_DATA__ found in ${url}`);

    const payload = JSON.parse(match[1]);
    if (!payload.success) throw new Error(`Plonkit payload was not successful for ${url}`);
    return payload.data;
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

function stableMetaId(slug, itemId) {
    return `meta_${slug}_${itemId}`.replace(/[^a-zA-Z0-9_]+/g, '_');
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
    const converted = [];
    for (const rawTag of tags || []) {
        const mapped = TAG_MAP[String(rawTag).toLowerCase()];
        if (mapped && !converted.includes(mapped)) converted.push(mapped);
    }
    return converted;
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

function isGuideEntry(entry) {
    return Array.isArray(entry.cat) && entry.cat.some((cat) => VALID_GUIDE_CATEGORIES.has(cat));
}

async function scrapeGuideIndex() {
    const html = await fetchText(GUIDE_URL);
    const entries = extractPreloadedData(html, GUIDE_URL);
    return entries.filter(isGuideEntry);
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
    const html = await fetchText(url);
    return flattenGuideItems(extractPreloadedData(html, url));
}

function loadExistingData() {
    if (!fs.existsSync(PLONKIT_METAS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PLONKIT_METAS_PATH, 'utf8'));
}

function buildCountryLookup(existingData) {
    const bySlug = new Map();
    const byCountry = new Map();

    for (const entry of existingData) {
        if (entry.slug) bySlug.set(String(entry.slug).toLowerCase(), entry);
        if (entry.country) byCountry.set(String(entry.country).toLowerCase(), entry);
        if (entry.url) {
            const slug = entry.url.split('/').filter(Boolean).pop();
            if (slug) bySlug.set(slug.toLowerCase(), entry);
        }
    }

    return { bySlug, byCountry };
}

function findExistingCountry(existingData, scrapedCountry) {
    const lookup = buildCountryLookup(existingData);
    return lookup.bySlug.get(scrapedCountry.slug.toLowerCase())
        || lookup.byCountry.get(scrapedCountry.country.toLowerCase())
        || null;
}

function findExistingMeta(existingMetas, scrapedMeta) {
    const byPlonkitId = existingMetas.find((meta) => meta.plonkitId && meta.plonkitId === scrapedMeta.plonkitId);
    if (byPlonkitId) return byPlonkitId;

    const byStableId = existingMetas.find((meta) => meta.id === scrapedMeta.id);
    if (byStableId) return byStableId;

    const imagePath = scrapedMeta.imageUrl ? new URL(scrapedMeta.imageUrl).pathname : '';
    const byImage = imagePath
        ? existingMetas.find((meta) => meta.imageUrl && new URL(meta.imageUrl).pathname === imagePath)
        : null;
    if (byImage) return byImage;

    const scrapedDescription = normalizeForMatch(scrapedMeta.description);
    return existingMetas.find((meta) => normalizeForMatch(meta.description) === scrapedDescription) || null;
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
    const usedExisting = new Set();
    const mergedMetas = [];

    for (const scrapedMeta of scrapedCountry.metas) {
        const existingMeta = findExistingMeta(existingMetas, scrapedMeta);
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

    for (const scrapedCountry of scrapedData) {
        const existingCountry = findExistingCountry(output, scrapedCountry);
        const mergedCountry = mergeCountry(existingCountry, scrapedCountry, stats);

        if (existingCountry) {
            const index = output.indexOf(existingCountry);
            output[index] = mergedCountry;
            stats.countriesUpdated += 1;
        } else {
            output.push(mergedCountry);
            stats.countriesAdded += 1;
        }
    }

    return { data: output, stats };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }

    const guideEntries = await scrapeGuideIndex();
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

    fs.writeFileSync(PLONKIT_METAS_PATH, stringifyJsonAscii(data));
    console.log(`Saved merged data to ${PLONKIT_METAS_PATH}`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
});
