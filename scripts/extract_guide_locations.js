const https = require('https');
const path = require('path');
const { getArg, getLowerCaseArg, parseIntArg } = require('./cli_utils');
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
        guideCache: getArg(argv, '--guide-cache='),
        report: getArg(argv, '--report='),
        urlCache: getArg(argv, '--url-cache='),
        skipGeocoding: argv.includes('--skip-geocoding'),
    };
}

function isMapsUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname === 'maps.app.goo.gl'
            || (parsed.hostname === 'goo.gl' && parsed.pathname.startsWith('/maps'))
            || (/^(?:www\.|maps\.)?google\.[a-z.]+$/.test(parsed.hostname)
                && (parsed.pathname.startsWith('/maps') || parsed.hostname.startsWith('maps.')));
    } catch { return false; }
}

function textMapsLinks(item) {
    return [...new Set((item.data?.text || []).flatMap(text =>
        String(text).match(/https?:\/\/[^\s<>"\])]+/g) || []).filter(isMapsUrl))];
}

function buildMetaLookup(plonkitData) {
    const lookup = new Map();

    for (const country of plonkitData) {
        const slug = country.slug || new URL(country.url).pathname.split('/').filter(Boolean).pop();
        for (const meta of country.metas || []) {
            if (meta.plonkitId && slug) lookup.set(`${slug}/${meta.plonkitId}`, meta.id);
        }
    }

    return lookup;
}

async function scrapeLocationTasks(entry, metaLookup, args, audit) {
    const url = `${BASE_URL}/${entry.slug}`;
    const payload = args.guideCache ? readJson(path.join(args.guideCache, `${entry.slug}.json`))
        : extractPreloadedData(await fetchText(url, { 'User-Agent': 'BetterMetasLocationExtractor/1.0' }), url);
    const guide = payload.public || payload;
    const tasks = [];

    for (const step of guide.steps || []) {
        for (const item of step.items || []) {
            if (item.kind !== 'tip' || !item.id) continue;
            const metaId = metaLookup.get(`${guide.slug}/${item.id}`);
            const link = item.data?.image?.imageLink;
            // Text links may illustrate counterexamples, so report them for review
            // instead of silently assigning their panoramas to this clue's country.
            const record = { country: guide.title, plonkitId: item.id, metaId, link: link || null,
                unreviewedTextLinks: textMapsLinks(item).filter(url => url !== link) };
            audit.push(record);
            if (!metaId) { record.status = 'unmatched_meta'; continue; }
            if (!link || link === '#') { record.status = 'no_link'; continue; }
            let mapsUrl;
            try { mapsUrl = new URL(link, BASE_URL).toString(); }
            catch { record.status = 'invalid_link'; continue; }
            if (!isMapsUrl(mapsUrl)) { record.status = 'non_maps_link'; continue; }

            tasks.push({
                country: guide.title,
                metaId,
                mapsUrl,
                record,
            });
        }
    }

    return tasks;
}

async function resolveUrl(url) {
    let resolvedUrl = url;
    for (let redirects = 0; redirects < 5 && /(?:goo\.gl|maps\.app\.goo\.gl)/.test(new URL(resolvedUrl).hostname); redirects += 1) {
        resolvedUrl = await new Promise((resolve) => {
            const request = https.get(resolvedUrl, { headers: { 'User-Agent': 'BetterMetasLocationExtractor/1.0' } }, (res) => {
                const nextUrl = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location
                    ? new URL(res.headers.location, resolvedUrl).toString()
                    : resolvedUrl;
                res.resume();
                resolve(nextUrl);
            }).on('error', () => resolve(resolvedUrl));
            request.setTimeout(15000, () => request.destroy(new Error('Maps redirect timeout')));
        });
    }
    return resolvedUrl;
}

function extractMapsLocation(url) {
    let panoid = null;
    let lat = null;
    let lng = null;

    let decoded;
    try { decoded = decodeURIComponent(url); } catch { return null; }

    const panoidMatch = decoded.match(/[!&]1s([^!&?]+)/) || decoded.match(/[?&]pano=([^&#]+)/);
    if (panoidMatch) panoid = panoidMatch[1];

    const latLngMatch = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
        || decoded.match(/[?&]viewpoint=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
        || decoded.match(/[?&]viewpoint=(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i);

    if (latLngMatch) {
        lat = Number.parseFloat(latLngMatch[1]);
        lng = Number.parseFloat(latLngMatch[2]);
    }

    if (!panoid || !Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
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
    const previous = locationsData[panoid] || {};
    const existing = Array.isArray(previous) ? {} : previous;
    const metas = [...(Array.isArray(previous) ? previous : existing.metas || [])];
    if (!metas.includes(task.metaId)) metas.push(task.metaId);

    locationsData[panoid] = {
        ...existing,
        ...Object.fromEntries(Object.entries(location).map(([key, value]) => [key, existing[key] ?? value])),
        metas,
        country: existing.country ?? task.country,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const plonkitData = readJson(PLONKIT_DATA_PATH, []);
    const locationsData = readJson(LOCATIONS_DATA_PATH, {});
    const metaLookup = buildMetaLookup(plonkitData);

    const audit = [];
    const urlCache = args.urlCache ? readJson(args.urlCache, {}) : {};
    let entries = args.guideCache ? readJson(path.join(args.guideCache, 'index.json'))
        : await scrapeGuideIndex({ 'User-Agent': 'BetterMetasLocationExtractor/1.0' });
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
        tasks.push(...await scrapeLocationTasks(entry, metaLookup, args, audit));
        if (!args.guideCache) await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log(`Found ${tasks.length} Google Maps-linked Plonkit metas.`);

    let lastNomRequestTime = 0;
    let resolved = 0;
    let linkedCached = 0;
    let failed = 0;
    let resolvedBatch = new Map();

    for (const [index, task] of tasks.entries()) {
        // Only URL redirects run concurrently. Geocoding remains sequential and
        // rate-limited, and all data writes happen in the ordered loop below.
        if (index % 4 === 0) {
            const batch = tasks.slice(index, index + 4);
            resolvedBatch = new Map(await Promise.all(batch.map(async item => [
                item.mapsUrl, urlCache[item.mapsUrl] || await resolveUrl(item.mapsUrl),
            ])));
        }
        if (index % 100 === 0) {
            console.log(`[${index}/${tasks.length}] new=${resolved}, cached=${linkedCached}, failed=${failed}`);
            if (args.urlCache) writeJsonAscii(args.urlCache, urlCache);
        }
        const finalUrl = resolvedBatch.get(task.mapsUrl);
        if (extractMapsLocation(finalUrl)) urlCache[task.mapsUrl] = finalUrl;
        const parsed = extractMapsLocation(finalUrl);
        task.record.resolvedUrl = finalUrl;
        if (!parsed) {
            task.record.status = /(?:goo\.gl)/.test(new URL(finalUrl).hostname)
                ? 'unresolved_short_link' : 'no_parseable_panorama';
            failed += 1;
            continue;
        }
        task.record.status = 'linked';
        task.record.panoid = parsed.panoid;

        const existing = locationsData[parsed.panoid];
        if (existing && typeof existing.lat === 'number' && Number.isFinite(existing.lat)
            && typeof existing.lng === 'number' && Number.isFinite(existing.lng)) {
            mergeLocation(locationsData, parsed.panoid, task, {
                lat: existing.lat,
                lng: existing.lng,
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
        if (!args.skipGeocoding && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastNomRequestTime = Date.now();

        const nomData = args.skipGeocoding ? null : await reverseGeocode(parsed.lat, parsed.lng);
        mergeLocation(locationsData, parsed.panoid, task, formatLocation(task, parsed, nomData));
        resolved += 1;

        if (!args.dryRun && resolved % 25 === 0) {
            writeJsonAscii(LOCATIONS_DATA_PATH, locationsData);
        }

        if ((index + 1) % 100 === 0) {
            console.log(`[${index + 1}/${tasks.length}] resolved=${resolved}, cached=${linkedCached}, failed=${failed}`);
        }
    }

    console.log(`New locations (${args.skipGeocoding ? 'coordinates only' : 'geocoding attempted'}): ${resolved}`);
    console.log(`Linked from cache: ${linkedCached}`);
    console.log(`Failed to parse: ${failed}`);

    if (args.report) writeJsonAscii(args.report, audit);
    if (args.urlCache) writeJsonAscii(args.urlCache, urlCache);

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
    mergeLocation,
    isMapsUrl,
    textMapsLinks,
};
