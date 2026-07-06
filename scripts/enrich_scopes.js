const fs = require('fs');
const path = require('path');
const { stringifyJsonAscii } = require('./json_utils');

const PLONKIT_METAS_PATH = path.join(__dirname, '../data/plonkit_metas.json');

function fallbackScopeForSection(section) {
    if (section === 'Step 2') return 'region';
    if (section === 'Step 3') return '10km';
    return 'countrywide';
}

function matchesAny(value, patterns) {
    return patterns.some((pattern) => pattern.test(value));
}

function determineScope(title = '', description = '', note = '', section = '') {
    const d = String(description || '').toLowerCase();
    const t = String(title || '').toLowerCase();
    const n = String(note || '').toLowerCase();
    const allText = `${d} ${t} ${n}`;

    const uniquePatterns = [
        /only found (at|in|near|around)\s+[A-Z]/i,
        /unique to\s+[A-Z]/i,
        /exclusively found/i,
        /the only\s+(place|location|spot)/i,
        /one of a kind/i,
        /single\s+(bridge|building|landmark)/i,
    ];
    if (matchesAny(description, uniquePatterns)) return 'unique';

    if (['monument', 'statue', 'memorial', 'landmark', 'fortress', 'castle', 'palace'].some((word) => d.includes(word))) {
        if (!d.includes('across the country') && !d.includes('throughout')) return 'unique';
    }

    const countrywidePatterns = [
        /(drives?|driving)\s+on\s+the\s+(left|right)/i,
        /(left|right)[-\s]hand\s+traffic/i,
        /(left|right)\s+side\s+of\s+the\s+road/i,
        /(licence|license)\s+plate/i,
        /plates?\s+(are|is)\s+(generally|typically|usually|commonly)/i,
        /official\s+language/i,
        /the\s+language\s+(is|in)/i,
        /(alphabet|script)\s+(is|uses?)/i,
        /(currency|money)\s+(is|in)/i,
        /(can\s+be\s+)?found\s+(throughout|across|all\s+over)\s+(the\s+)?country/i,
        /(everywhere|anywhere)\s+in\s+\w+/i,
        /in\s+all\s+(parts|regions|areas)\s+of/i,
        /(common|typical|standard)\s+(throughout|across)\s+\w+/i,
        /(generally|typically|usually)\s+use[sd]?\s+(yellow|white|blue|red|green)/i,
        /all\s+(roads?|coverage)\s+in\s+\w+/i,
        /\w+\s+(primarily|mainly|mostly)\s+uses?/i,
    ];
    if (matchesAny(description, countrywidePatterns)) return 'countrywide';

    const countrywideKeywords = [
        'licence plate', 'license plate',
        'drives on the left', 'drives on the right',
        'left-hand traffic', 'right-hand traffic',
        'official language',
        'the coverage in',
        'google car', 'pickup truck',
    ];
    for (const keyword of countrywideKeywords) {
        if (d.includes(keyword) && !['north', 'south', 'east', 'west', 'region', 'coast', 'area'].some((word) => d.includes(word))) {
            return 'countrywide';
        }
    }

    if ((d.includes('road') || d.includes('roads')) && (d.includes('yellow') || d.includes('white')) && d.includes('line')) {
        if (['outer', 'center', 'centre', 'middle'].some((word) => d.includes(word))) return 'countrywide';
    }

    if (section === 'Step 1' && ['can be', 'are used', 'typically use', 'primarily use', 'generally'].some((word) => d.includes(word))) {
        return 'countrywide';
    }

    const regionPatterns = [
        /(northern|southern|eastern|western|central)\s+(part|half|portion|region|area)/i,
        /(the\s+)?(north|south|east|west)\s+of\s+the\s+country/i,
        /in\s+the\s+(north|south|east|west)(ern)?/i,
        /(north|south|east|west)\s+of\s+\w+/i,
        /(coast|coastal)\s+(region|area)/i,
        /panhandle/i,
        /region\s+of\s+\w+/i,
        /\w+\s+region/i,
        /\w+\s+province/i,
        /\w+\s+state\b/i,
    ];
    if (matchesAny(description, regionPatterns)) return 'region';
    if (d.includes('longitude') || d.includes('meridian')) return 'region';

    if (/(entire|whole)\s+(western|eastern|northern|southern)\s+half/i.test(d)) return '1000km';

    if ((t.includes('city') || t.includes('capital')) && (d.includes('around') || d.includes('surrounding') || d.includes('region'))) {
        return '100km';
    }

    if (d.includes('mountain') && (d.includes('range') || d.includes('visible from') || d.includes('can be seen'))) {
        if (!d.includes('everywhere') && !d.includes('across')) return '100km';
    }

    const roadPatterns = [
        /\b[A-Z]\d+\s+between\s+\w+\s+and\s+\w+/i,
        /\b[A-Z]\d+\s+(north|south|east|west)\s+of\s+\w+/i,
        /(road|highway)\s+\w+\s+between/i,
        /section\s+of\s+(road|highway)?\s*[A-Z]?\d+/i,
        /stretch\s+of\s+(road|highway)?\s*[A-Z]?\d+/i,
    ];
    if (matchesAny(description, roadPatterns)) return 'road';
    if (/\b[ABCDEFM]\d+\b/i.test(description) || /road\s+[ABCDEFM]\d+/i.test(d)) return 'road';

    const townPatterns = [
        /in\s+[A-Z][a-z]+\s+(you|the|there|most)/,
        /[A-Z][a-z]+\s+(is|has|can|features?)/,
        /around\s+[A-Z][a-z]+/,
        /the\s+town\s+of\s+[A-Z]/,
        /the\s+city\s+of\s+[A-Z]/,
        /from\s+[A-Z][a-z]+\s+(you|the)/,
    ];
    for (const pattern of townPatterns) {
        if (pattern.test(description) && ['recogni', 'distinguish', 'identify', 'can be seen', 'visible', 'surround'].some((word) => d.includes(word))) {
            return 'city';
        }
    }

    const townInTitle = String(title || '').match(/^([A-Z][a-z]+(?:[-\s][A-Z][a-z]+)?)\s/);
    if (townInTitle) {
        const townName = townInTitle[1].toLowerCase();
        const excluded = new Set(['the', 'a', 'an', 'road', 'route', 'highway', 'blue', 'red', 'green', 'yellow', 'white', 'black', 'north', 'south', 'east', 'west', 'left', 'right', 'gen', 'main', 'limited', 'desert', 'coastal', 'mountain', 'flat', 'coverage']);
        if (!excluded.has(townName) && /\b(city|town|view|grid|hills|ridge|mountain|feature|features)\b/i.test(t)) return 'city';
    }

    const km1Patterns = [
        /(downtown|centre|center|cbd)\s+of/i,
        /(part|neighborhood|district)\s+of\s+(the\s+)?(town|city)/i,
        /(west|east|north|south)ern?\s+part\s+of\s+(the\s+)?(town|city)/i,
    ];
    if (matchesAny(description, km1Patterns)) return '1km';

    const simpleHeaders = ['landscape', 'roads', 'infrastructure', 'car meta', 'towns', 'important notes', 'overview'];
    for (const header of simpleHeaders) {
        if (d.trim() === header || t.trim() === header) return fallbackScopeForSection(section);
    }

    if (['map', 'header', 'overview', 'notes'].some((word) => t.includes(word))) return fallbackScopeForSection(section);
    if (/(along|throughout)\s+the\s+road/i.test(d)) return fallbackScopeForSection(section);
    if (d.includes('can be found') && d.length < 100) return 'countrywide';
    if (section === 'Step 1') return 'countrywide';
    if (section === 'Step 2') return 'region';
    if (section === 'Step 3') return '10km';
    return fallbackScopeForSection(section);
}

function parseArgs(argv) {
    return {
        dryRun: argv.includes('--dry-run'),
        country: (argv.find((arg) => arg.startsWith('--country=')) || '').split('=').slice(1).join('=').trim().toLowerCase() || null,
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = JSON.parse(fs.readFileSync(PLONKIT_METAS_PATH, 'utf8'));
    const stats = {
        countrywide: 0,
        region: 0,
        city: 0,
        road: 0,
        '1000km': 0,
        '100km': 0,
        '10km': 0,
        '1km': 0,
        unique: 0,
    };

    let count = 0;
    for (const countryData of data) {
        const countryKey = String(countryData.slug || countryData.country || '').toLowerCase();
        if (args.country && countryKey !== args.country && String(countryData.country || '').toLowerCase() !== args.country) continue;

        for (const meta of countryData.metas || []) {
            const scope = determineScope(meta.title, meta.description, meta.note, meta.section);
            meta.scope = scope;
            stats[scope] += 1;
            count += 1;
        }
    }

    console.log('SCOPE DISTRIBUTION');
    Object.entries(stats)
        .sort((a, b) => b[1] - a[1])
        .forEach(([scope, value]) => console.log(`${scope.padEnd(12)} ${String(value).padStart(5)}`));
    console.log(`Total: ${count} metas processed`);

    if (args.dryRun) {
        console.log('Dry run: no files written.');
        return;
    }

    fs.writeFileSync(PLONKIT_METAS_PATH, stringifyJsonAscii(data));
    console.log(`Saved scopes to ${PLONKIT_METAS_PATH}`);
}

if (require.main === module) main();

module.exports = {
    determineScope,
};
