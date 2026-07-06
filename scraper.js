const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { stringifyJsonAscii } = require('./scripts/json_utils');

const BASE_URL = 'https://www.plonkit.net';
const GUIDE_URL = `${BASE_URL}/guide`;
const PLONKIT_METAS_PATH = path.join(__dirname, 'data/plonkit_metas.json');

async function scrapeGuideLinks(browser) {
    const page = await browser.newPage();
    console.log(`Navigating to ${GUIDE_URL}...`);
    try {
        await page.goto(GUIDE_URL, { waitUntil: 'networkidle2' });
        
        const links = await page.evaluate(() => {
            const results = [];
            
            // 1. Get explicit links (Recently Added & others)
            const ignore = ['/guide', '/privacy', '/terms', '/login', '/signup', 
                            '/records', '/maps', '/donated', '/features', '/about', 
                            '/leaderboard', '/tools', '/changelog', '/feedback', 
                            '/guide-editor', '/beginners-guide', '/shop',
                            '/rules', '/submit', '/regional', '/highscores', '/speedruns', '/top', '/map', '/u',
                            '/', '/donate'];

            document.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                if (href && href.startsWith('/') && href.split('/').length === 2) {
                    if (!ignore.includes(href) && !href.match(/^\/\d{1,2}-\d{1,2}-\d{4}$/)) { // Filter dates
                        results.push(href);
                    }
                }
            });

            // 2. Parse Tables (for countries without direct links)
            // Slug overrides for countries where name != url
            const slugOverrides = {
                'united states of america': 'united-states',
                'israel & the west bank': 'israel-west-bank', 
                'south georgia & sandwich islands': 'south-georgia-sandwich-islands', 
                'china': 'china', 
                'turkey': 'turkey'
            };

            const rows = document.querySelectorAll('table tbody tr');
            rows.forEach(row => {
               const distinctCells = row.querySelectorAll('td');
               if (distinctCells.length >= 2) {
                   const name = distinctCells[1].innerText.trim();
                   
                   let slug = null;
                   if (slugOverrides[name.toLowerCase()]) {
                       slug = slugOverrides[name.toLowerCase()];
                   } else {
                       slug = name.toLowerCase()
                           .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
                           .replace(/&/g, 'and')
                           .replace(/[^a-z0-9]+/g, '-')
                           .replace(/^-+|-+$/g, '');
                   }
                   
                   if (slug) {
                        // Special fix for dates which might appear as table rows in changelogs if table selector is too broad?
                        // The selector `table tbody tr` is broad. The guide page has a changelog table at the bottom?
                        // User log showed date links: /14-12-2025. 
                        // These probably come from a "Last Updated" column or a changelog table.
                        // We can filter by checking if the slug looks like a date.
                        if (!slug.match(/^\d{1,2}-\d{1,2}-\d{4}$/)) {
                            results.push(`/${slug}`);
                        }
                   }
               }
            });

            return results;
        });

        // Deduplicate
        return [...new Set(links)];
    } catch (e) {
        console.error("Error scraping guide:", e);
        return [];
    } finally {
        await page.close();
    }
}

async function scrapeCountry(browser, urlPath) {
    const page = await browser.newPage();
    const fullUrl = `${BASE_URL}${urlPath}`;
    console.log(`Scraping ${fullUrl}...`);
    
    try {
        await page.goto(fullUrl, { waitUntil: 'networkidle2' });
        
        // Wait for content. The user said divs have ids like "1-1".
        try {
            await page.waitForSelector('div[id="1-1"]', { timeout: 5000 });
        } catch (e) {
            console.log("No standard content found (timeout waiting for #1-1).");
        }

        const data = await page.evaluate((fullUrl) => {
            const countryName = document.querySelector('h1')?.innerText || 'Unknown';
            const metas = [];
            const fallbackScopeForSection = (section) => {
                if (section === 'Step 2') return 'region';
                if (section === 'Step 3') return '10km';
                return 'countrywide';
            };

            // Find all divs with ID matching digit-digit
            const contentDivs = Array.from(document.querySelectorAll('div[id]'))
                .filter(div => div.id.match(/^\d+-\d+$/));

            contentDivs.forEach(div => {
                const id = div.id;
                const sectionId = id.split('-')[0];
                
                // User requested shortened names "Step 1", etc.
                let section = `Step ${sectionId}`;

                // Extract Image
                const imgEl = div.querySelector('img');
                let imageUrl = imgEl ? imgEl.src : null;

                // Extract Text and Notes
                // We use innerText to capture all visible text including formatting spacing
                let fullText = div.innerText.trim();
                
                let text = fullText;
                let note = '';

                // Try to split NOTE:
                // Regex to find "NOTE:" at start of a line or paragraph
                const noteMatch = fullText.match(/NOTE:\s*(.*)/s);
                if (noteMatch) {
                    note = noteMatch[1].trim();
                    text = fullText.replace(noteMatch[0], '').trim();
                }

                // Determine a "Title" ?
                // Often the first line or sentence is the key.
                // We'll just store the text. User asked for Title, but it's not strictly structured.
                // We can try to guess title strings if they are short?
                // Let's stick to Text and Note.

                // Generate Random ID to match existing format: meta_<timestamp>_<random>
                const uniqueId = "meta_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

                // Only add if there is a description (text), as per user request to ignore non-metas
                if ((imageUrl || text || note) && text && text.trim().length > 0) {
                    metas.push({
                        id: uniqueId,
                        country: countryName,
                        section: section,
                        title: '', 
                        description: text, 
                        note: note,
                        imageUrl: imageUrl,
                        scope: fallbackScopeForSection(section),
                        tags: []
                    });
                }
            });

            return {
                country: countryName,
                url: fullUrl,
                metas
            };
        }, fullUrl);

        await page.close();
        return data;

    } catch (e) {
        console.error(`Error scraping ${fullUrl}:`, e);
        await page.close();
        return null;
    }
}

async function main() {
    const isTest = process.argv.includes('--test');
    
    // Try to find system Chrome if bundled one fails, or allow user override
    const userExecutablePath = process.argv.find(arg => arg.startsWith('--executable-path='))?.split('=')[1];
    
    // Common macOS Chrome path
    const systemChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    
    const launchOptions = {
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    if (userExecutablePath) {
        launchOptions.executablePath = userExecutablePath;
    } else if (fs.existsSync(systemChromePath)) {
        console.log(`Using system Chrome at ${systemChromePath}`);
        launchOptions.executablePath = systemChromePath;
    }

    const browser = await puppeteer.launch(launchOptions);

    try {
        let links = await scrapeGuideLinks(browser);
        console.log(`Found ${links.length} potential country pages.`);
        
        if (isTest) {
            const testLink = links.find(l => l.includes('united-states')) || '/united-states';
            console.log(`Testing on ${testLink}...`);
            const result = await scrapeCountry(browser, testLink);
            console.log(stringifyJsonAscii(result));
        } else {
            const results = [];
            for (const link of links) {
                const result = await scrapeCountry(browser, link);
                if (result) results.push(result);
            }
            fs.writeFileSync(PLONKIT_METAS_PATH, stringifyJsonAscii(results));
            console.log(`Saved data for ${results.length} countries.`);
        }
    } catch (e) {
        console.error("Main error:", e);
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
});
