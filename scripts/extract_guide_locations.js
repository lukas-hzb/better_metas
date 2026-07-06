
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const https = require('https');
const { stringifyJsonAscii } = require('./json_utils');

const PLONKIT_DATA_PATH = path.join(__dirname, '../data/plonkit_metas.json');
const LOCATIONS_DATA_PATH = path.join(__dirname, '../data/plonkit_locations.json');

// --- Configuration ---
const NOMINATIM_RATE_LIMIT_MS = 1200; // Limit to 1 request per 1.2s to be safe

async function main() {
    console.log('Starting Optimized Extraction...');

    // 1. Load Data
    const plonkitData = JSON.parse(fs.readFileSync(PLONKIT_DATA_PATH, 'utf8'));
    let locationsData = {};
    if (fs.existsSync(LOCATIONS_DATA_PATH)) {
        try {
            locationsData = JSON.parse(fs.readFileSync(LOCATIONS_DATA_PATH, 'utf8'));
        } catch (e) {
            console.error('Error parsing plonkit_locations.json, starting fresh.', e);
        }
    }

    // 2. Identify Missing Locations (Tasks)
    // We scrape *all* links first to build a task list.
    const tasks = [];
    
    // Optional: User filter
    const targetCountry = process.argv.find(arg => arg.startsWith('--country='))?.split('=')[1];

    console.log('Launching Puppeteer for scraping links (HEADLESS)...');
    
    // Attempt to locate system chrome
    const systemChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // Mac default

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: fs.existsSync(systemChromePath) ? systemChromePath : undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        for (const countryEntry of plonkitData) {
            if (targetCountry && countryEntry.country.toLowerCase() !== targetCountry.toLowerCase()) continue;

            console.log(`Scraping links for ${countryEntry.country}...`);
            const page = await browser.newPage();
            
            try {
                // Use networkidle2 to ensure page loads fully
                await page.goto(countryEntry.url, { waitUntil: 'networkidle2', timeout: 60000 });
                
                // Extract Links
                const potentialLinks = await page.evaluate(() => {
                    // Get all anchors first, then filter
                    // This is more robust than a complex CSS selector if the DOM is weird
                    const anchors = Array.from(document.querySelectorAll('a'));
                    return anchors.map(a => {
                        const href = a.href;
                        const img = a.querySelector('img');
                        
                        // Check if it's a maps link
                        const isMaps = href.includes('google.com/maps') || href.includes('goo.gl/maps') || href.includes('maps.app.goo.gl');
                        
                        if (!isMaps || !img) return null;
                        
                        return {
                            mapsUrl: href,
                            imgSrc: img.src
                        };
                    }).filter(item => item !== null);
                });
                
                // Match to Metas immediately
                for (const link of potentialLinks) {
                     const matchingMeta = countryEntry.metas.find(meta => {
                         if (!meta.imageUrl) return false;
                         return link.imgSrc.includes(meta.imageUrl) || meta.imageUrl.includes(link.imgSrc);
                    });

                    if (matchingMeta) {
                        // Check if we need to process this
                        // Useful to re-process if road is null or "Unknown", or if user forced it.
                        // Assuming we want to ensure coverage.
                        tasks.push({
                            country: countryEntry.country,
                            metaId: matchingMeta.id,
                            mapsUrl: link.mapsUrl, // Might be short link
                            status: 'pending'
                        });
                    }
                }
                console.log(`  Found ${potentialLinks.length} potential links -> ${tasks.length} total tasks so far.`);

            } catch (e) {
                console.error(`  Error scraping ${countryEntry.country}:`, e.message);
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
        console.log('Scraping finished. Closing browser.');
    }

    console.log(`Total Tasks to process: ${tasks.length}`);

    // 3. Process Tasks sequentially to respect Nominatim rate limits.
    
    // We need a helper to resolving short links via HEAD request (or GET)
    async function resolveUrl(url) {
        return new Promise((resolve, reject) => {
            if (!url.includes('goo.gl') && !url.includes('maps.app.goo.gl')) {
                return resolve(url);
            }
            https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    resolve(res.headers.location);
                } else {
                    // Sometimes it returns 200 with JS redirect? 
                    // Maps short links usually 302 redirect.
                    resolve(res.responseUrl || url); 
                }
            }).on('error', (e) => resolve(url)); // Fallback
        });
    }

    // Nominatim Helper
    async function geocodeNominatim(lat, lng) {
        return new Promise((resolve) => {
            const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=en`;
            const req = https.get(url, {
                headers: { 'User-Agent': 'GeoguessrMetaScript/1.0 (contact: github_issue)' } // Etiquette
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
        });
    }

    // Processing Loop
    let lastNomRequestTime = 0;
    let skippedCount = 0;
    let processedCount = 0;

    console.log('\n--- Processing Tasks ---');

    for (const [index, task] of tasks.entries()) {
        const progress = `[${index + 1}/${tasks.length}]`;
        
        try {
            // A. Resolve Link
            let finalUrl = await resolveUrl(task.mapsUrl);
            if (finalUrl.includes('goo.gl')) finalUrl = await resolveUrl(finalUrl);

            // B. Extract Panoid / LatLng
            let panoid = null;
            let lat = null;
            let lng = null;

            const panoidMatch = finalUrl.match(/!1s([^!]+)/);
            if (panoidMatch) panoid = panoidMatch[1];

            const latLngMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
            if (latLngMatch) {
                lat = parseFloat(latLngMatch[1]);
                lng = parseFloat(latLngMatch[2]);
            }

            if (panoid && lat && lng) {
                // SKIP CHECK: If we already have this panoid with valid road/region, skip geocoding
                const existing = locationsData[panoid];
                if (existing && existing.road && existing.region && Object.prototype.hasOwnProperty.call(existing, 'city')) {
                    let needsUpdate = false;
                    if (!Array.isArray(existing.metas)) {
                        existing.metas = [];
                        needsUpdate = true;
                    }
                    
                    // Link meta if missing
                    if (!existing.metas.includes(task.metaId)) {
                        existing.metas.push(task.metaId);
                        needsUpdate = true;
                    }
                    
                    // PROACTIVE FIX: Update country to Plonkit context if it mismatches
                    if (existing.country !== task.country) {
                        existing.nominatimCountry = existing.country; // Move old to backup
                        existing.country = task.country;
                        needsUpdate = true;
                    }

                    if (needsUpdate) {
                        fs.writeFileSync(LOCATIONS_DATA_PATH, stringifyJsonAscii(locationsData));
                    }
                    
                    skippedCount++;
                    process.stdout.write(`\r\x1b[36m${progress} Skipped (Cached/Fixed): ${panoid}\x1b[0m\x1b[K`);
                    continue;
                }

                // C. Geocode (Nominatim)
                const now = Date.now();
                const timeSinceLast = now - lastNomRequestTime;
                if (timeSinceLast < NOMINATIM_RATE_LIMIT_MS) {
                    await new Promise(r => setTimeout(r, NOMINATIM_RATE_LIMIT_MS - timeSinceLast));
                }
                lastNomRequestTime = Date.now();

                const nomData = await geocodeNominatim(lat, lng);
                
                let road = null;
                let region = null;
                let city = null;
                let country = task.country; 
                let nominatimCountry = null;

                if (nomData && nomData.address) {
                    const a = nomData.address;
                    const roadName = a.road || a.pedestrian || a.highway || a.street || a.suburb || a.hamlet || a.village || null;
                    if (roadName) {
                        road = roadName.includes(';') ? roadName.split(';').map(s => s.trim()) : roadName;
                    }
                    region = a.state || a.region || a.province || a.county || a.district || null;
                    city = a.city || a.town || a.village || a.hamlet || a.municipality || null;
                    nominatimCountry = a.country || null;
                }

                // D. Update Data
                if (!locationsData[panoid]) {
                    locationsData[panoid] = { metas: [], lat, lng, country, region, city, road, nominatimCountry };
                } else {
                    locationsData[panoid] = { ...locationsData[panoid], lat, lng, country, region, city, road, nominatimCountry };
                }

                if (!Array.isArray(locationsData[panoid].metas)) {
                    locationsData[panoid].metas = [];
                }

                if (!locationsData[panoid].metas.includes(task.metaId)) {
                    locationsData[panoid].metas.push(task.metaId);
                }
                
                processedCount++;
                const displayRoad = Array.isArray(road) ? road.join(', ') : (road || 'null');
                process.stdout.write(`\r\x1b[32m${progress} Resolved: ${displayRoad} | ${region || 'null'}\x1b[0m\x1b[K`);

                fs.writeFileSync(LOCATIONS_DATA_PATH, stringifyJsonAscii(locationsData));

            } else {
                process.stdout.write(`\r\x1b[33m${progress} Failed URL: ${finalUrl.substring(0, 30)}...\x1b[0m\x1b[K`);
            }

        } catch (e) {
            console.log(`\n\x1b[31mError processing ${task.metaId}: ${e.message}\x1b[0m`);
        }
    }

    console.log(`\n\n--- Summary ---`);
    console.log(`\x1b[32mProcessed: ${processedCount}\x1b[0m`);
    console.log(`\x1b[36mSkipped (Cached): ${skippedCount}\x1b[0m`);
    console.log(`Done.`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
});
