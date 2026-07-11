const https = require('https');
const path = require('path');
const { getLowerCaseArg, parseIntArg } = require('./cli_utils');
const { readJson, writeJsonAscii } = require('./json_utils');
const {
    BASE_URL,
    extractPreloadedData,
    fetchText,
    scrapeGuideIndex,
} = require('./plonkit_utils');
const PLONKIT_DATA_PATH = path.join(__dirname, '../data/plonkit_metas.json');
const LOCATIONS_DATA_PATH = path.join(__dirname, '../data/plonkit_locations.json');
const NOMINATIM_RATE_LIMIT_MS = 1200;

function parseArgs(argv) {
    return {
        dryRun: argv.includes('--dry-run'),
        country: getLowerCaseArg(argv, '--country='),
        limit: parseIntArg(argv, '--limit='),
    };
}

function normalizeImagePath(url) {
    if (!url) return '';
    return new URL(url, BASE_URL).pathname;
}

function isMapsUrl(url) {
    return /(?:google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)/.test(url || '');
}

function buildMetaLookup(plonkitData) {
    const lookup = new Map();

    for (const country of plonkitData) {
        const slug = country.slug || new URL(country.url).pathname.split('/').filter(Boolean).pop();
        for (const meta of country.metas || []) {
            if (meta.plonkitId && slug) lookup.set(`${slug}/${meta.plonkitId}`, meta.id);
            if (meta.imageUrl) lookup.set(`${slug}/image:${normalizeImagePath(meta.imageUrl)}`, meta.id);
        }
    }

    return lookup;
}

async function scrapeLocationTasks(entry, metaLookup) {
    const url = `${BASE_URL}/${entry.slug}`;
    const html = await fetchText(url, { 'User-Agent': 'BetterMetasLocationExtractor/1.0' });
    const guide = extractPreloadedData(html, url).public;
    const tasks = [];

    for (const step of guide.steps || []) {
        for (const item of step.items || []) {
            if (item.kind !== 'tip' || !item.id || !item.data?.image?.imageLink) continue;

            const mapsUrl = new URL(item.data.image.imageLink, BASE_URL).toString();
            if (!isMapsUrl(mapsUrl)) continue;

            const metaId = metaLookup.get(`${guide.slug}/${item.id}`)
                || metaLookup.get(`${guide.slug}/image:${normalizeImagePath(item.data.image.imageUrl)}`);

            if (!metaId) continue;

            tasks.push({
                country: guide.title,
                metaId,
                mapsUrl,
            });
        }
    }

    return tasks;
}

async function resolveUrl(url) {
    let resolvedUrl = url;
    for (let redirects = 0; redirects < 2 && /(?:goo\.gl|maps\.app\.goo\.gl)/.test(resolvedUrl); redirects += 1) {
        resolvedUrl = await new Promise((resolve) => {
            https.get(resolvedUrl, { headers: { 'User-Agent': 'BetterMetasLocationExtractor/1.0' } }, (res) => {
                const nextUrl = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location
                    ? new URL(res.headers.location, resolvedUrl).toString()
                    : resolvedUrl;
                res.resume();
                resolve(nextUrl);
            }).on('error', () => resolve(resolvedUrl));
        });
    }
    return resolvedUrl;
}

function extractMapsLocation(url) {
    let panoid = null;
    let lat = null;
    let lng = null;

    const decoded = decodeURIComponent(url);

    const panoidMatch = decoded.match(/[!&]1s([^!&?]+)/) || decoded.match(/[?&]pano=([^&#]+)/);
    if (panoidMatch) panoid = panoidMatch[1];

    const latLngMatch = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
        || decoded.match(/[?&]viewpoint=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
        || decoded.match(/[?&]viewpoint=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i);

    if (latLngMatch) {
        lat = Number.parseFloat(latLngMatch[1]);
        lng = Number.parseFloat(latLngMatch[2]);
    }

    if (!panoid || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { panoid, lat, lng };
}

async function reverseGeocode(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=en`;
    try {
        return JSON.parse(await fetchText(url, {
            'User-Agent': 'BetterMetasLocationExtractor/1.0 (local project script)',
        }));
    } catch (err) {
        return null;
    }
}

function formatLocation(task, parsed, nomData) {
    let road = null;
    let region = null;
    let city = null;
    let nominatimCountry = null;

    if (nomData?.address) {
        const a = nomData.address;
        const roadName = a.road || a.pedestrian || a.highway || a.street || a.suburb || a.hamlet || a.village || null;
        road = roadName && roadName.includes(';') ? roadName.split(';').map((s) => s.trim()) : roadName;
        region = a.state || a.region || a.province || a.county || a.district || null;
        city = a.city || a.town || a.village || a.hamlet || a.municipality || null;
        nominatimCountry = a.country || null;
    }

    return {
        lat: parsed.lat,
        lng: parsed.lng,
        country: task.country,
        region,
        city,
        road,
        nominatimCountry,
    };
}

function mergeLocation(locationsData, panoid, task, location) {
    const existing = locationsData[panoid] || {};
    const metas = Array.isArray(existing.metas) ? existing.metas : [];
    if (!metas.includes(task.metaId)) metas.push(task.metaId);

    locationsData[panoid] = {
        metas,
        ...existing,
        ...location,
        country: task.country,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const plonkitData = readJson(PLONKIT_DATA_PATH, []);
    const locationsData = readJson(LOCATIONS_DATA_PATH, {});
    const metaLookup = buildMetaLookup(plonkitData);

    let entries = await scrapeGuideIndex({ 'User-Agent': 'BetterMetasLocationExtractor/1.0' });
    if (args.country) {
        entries = entries.filter((entry) => (
            entry.slug.toLowerCase() === args.country
            || entry.title.toLowerCase() === args.country
        ));
        if (entries.length === 0) throw new Error(`No guide entry matched --country=${args.country}`);
    }
    if (Number.isInteger(args.limit) && args.limit > 0) entries = entries.slice(0, args.limit);

    const tasks = [];
    for (const [index, entry] of entries.entries()) {
        console.log(`[${index + 1}/${entries.length}] Reading Plonkit links for ${entry.title}...`);
        tasks.push(...await scrapeLocationTasks(entry, metaLookup));
    }

    console.log(`Found ${tasks.length} Google Maps-linked Plonkit metas.`);

    let lastNomRequestTime = 0;
    let resolved = 0;
    let linkedCached = 0;
    let failed = 0;

    for (const [index, task] of tasks.entries()) {
        const finalUrl = await resolveUrl(task.mapsUrl);
        const parsed = extractMapsLocation(finalUrl);
        if (!parsed) {
            failed += 1;
            continue;
        }

        const existing = locationsData[parsed.panoid];
        if (existing && Number.isFinite(Number(existing.lat)) && Number.isFinite(Number(existing.lng))) {
            mergeLocation(locationsData, parsed.panoid, task, {
                lat: parsed.lat,
                lng: parsed.lng,
                country: task.country,
                region: existing.region ?? null,
                city: existing.city ?? null,
                road: existing.road ?? null,
                nominatimCountry: existing.nominatimCountry ?? null,
            });
            linkedCached += 1;
            continue;
        }

        const now = Date.now();
        const waitMs = NOMINATIM_RATE_LIMIT_MS - (now - lastNomRequestTime);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastNomRequestTime = Date.now();

        const nomData = await reverseGeocode(parsed.lat, parsed.lng);
        mergeLocation(locationsData, parsed.panoid, task, formatLocation(task, parsed, nomData));
        resolved += 1;

        if (!args.dryRun && resolved % 25 === 0) {
            writeJsonAscii(LOCATIONS_DATA_PATH, locationsData);
        }

        if ((index + 1) % 100 === 0) {
            console.log(`[${index + 1}/${tasks.length}] resolved=${resolved}, cached=${linkedCached}, failed=${failed}`);
        }
    }

    console.log(`Resolved with geocoding: ${resolved}`);
    console.log(`Linked from cache: ${linkedCached}`);
    console.log(`Failed to parse: ${failed}`);

    if (args.dryRun) {
        console.log('Dry run: no files written.');
        return;
    }

    writeJsonAscii(LOCATIONS_DATA_PATH, locationsData);
    console.log(`Saved ${Object.keys(locationsData).length} locations to ${LOCATIONS_DATA_PATH}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exitCode = 1;
    });
}

module.exports = {
    extractMapsLocation,
    resolveUrl,
};
