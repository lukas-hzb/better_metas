const https = require('https');

const BASE_URL = 'https://www.plonkit.net';
const GUIDE_URL = `${BASE_URL}/guide`;
const VALID_GUIDE_CATEGORIES = new Set([
    'Africa',
    'Antarctica',
    'Asia',
    'Europe',
    'North America',
    'Oceania',
    'South America',
]);

function fetchText(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, url).toString();
                res.resume();
                fetchText(nextUrl, headers).then(resolve, reject);
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

function isGuideEntry(entry) {
    return Array.isArray(entry.cat) && entry.cat.some((cat) => VALID_GUIDE_CATEGORIES.has(cat));
}

function stableMetaId(slug, itemId) {
    return `meta_${slug}_${itemId}`.replace(/[^a-zA-Z0-9_]+/g, '_');
}

async function scrapeGuideIndex(headers) {
    const html = await fetchText(GUIDE_URL, headers);
    return extractPreloadedData(html, GUIDE_URL).filter(isGuideEntry);
}

module.exports = {
    BASE_URL,
    GUIDE_URL,
    fetchText,
    extractPreloadedData,
    isGuideEntry,
    scrapeGuideIndex,
    stableMetaId,
};
