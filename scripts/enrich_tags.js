const path = require('path');
const { getLowerCaseArg } = require('./cli_utils');
const { readJson, writeJsonAscii } = require('./json_utils');

const PLONKIT_METAS_PATH = path.join(__dirname, '../data/plonkit_metas.json');

const TAG_PATTERNS = {
    plants: [
        /\b(tree|trees|forest|vegetation|grass|grassy|shrub|shrubbery|bush|bushes)\b/i,
        /\b(palm|pine|birch|spruce|acacia|eucalyptus|bamboo|cactus|cacti)\b/i,
        /\b(farmland|agricultural|crop|crops|field|fields|vineyard|orchard)\b/i,
        /\b(green|lush|vegetated|forested|jungle|rainforest)\b/i,
        /\b(flower|flowers|plant|plants|garden)\b/i,
    ],
    landscape: [
        /\b(landscape|landscapes|scenery|scenic|terrain)\b/i,
        /\b(mountain|mountains|hill|hills|valley|valleys|cliff|cliffs|plateau)\b/i,
        /\b(desert|savanna|steppe|tundra|plain|plains|coast|coastal)\b/i,
        /\b(arid|dry|lush|flat|hilly|mountainous)\s+(area|region|landscape|terrain)\b/i,
    ],
    bollards: [
        /\b(bollard|bollards|delineator|delineators)\b/i,
        /\b(road\s+marker|post\s+marker)\b/i,
        /\b(kilometer\s+marker|km\s+marker|mile\s+marker)\b/i,
        /\b(reflector\s+post|guide\s+post)\b/i,
    ],
    poles: [
        /\b(pole|poles)\b/i,
        /\b(lamp\s*post|lamppost|street\s+lamp|street\s+light)\b/i,
        /\b(power\s+line|power\s+lines|electric\s+line)\b/i,
        /\b(utility\s+pole|telegraph\s+pole|telephone\s+pole)\b/i,
        /\b(insulator|insulators)\b/i,
        /\b(wooden\s+pole|concrete\s+pole|metal\s+pole)\b/i,
    ],
    signs: [
        /\b(sign|signs|signpost|signage)\b/i,
        /\b(street\s+sign|road\s+sign|directional\s+sign)\b/i,
        /\b(speed\s+limit|stop\s+sign|yield\s+sign)\b/i,
        /\b(billboard|placard|notice)\b/i,
        /\b(chevron|chevrons)\b/i,
        /\b(warning\s+sign|information\s+sign)\b/i,
    ],
    language: [
        /\b(language|alphabet|script)\b/i,
        /\b(cyrillic|latin|arabic|devanagari|thai|chinese|japanese|korean|hebrew)\b/i,
        /\b(writing|written|text|letter|letters)\b/i,
        /\b(bilingual|multilingual|dual\s+script)\b/i,
        /\b(english|french|spanish|german|russian|portuguese)\b/i,
    ],
    plates: [
        /\b(licence\s+plate|license\s+plate|number\s+plate)\b/i,
        /\b(plate|plates)\b(?!.*tectonic)/i,
        /\b(vehicle\s+registration|car\s+registration)\b/i,
        /\b(yellow\s+plate|white\s+plate|blue\s+plate|red\s+plate)\b/i,
    ],
    cars: [
        /\b(pickup\s+truck|pickup)\b/i,
        /\b(google\s+car|street\s+view\s+car|coverage\s+car|car\s+blur)\b/i,
        /\b(antenna|antennae)\b/i,
        /\b(car\s+meta|vehicle\s+meta|car\s+feature)\b/i,
        /\b(follow\s+car|chase\s+car|trekker|shampoo)\b/i,
        /\b(white\s+car|black\s+car|silver\s+car|white\s+pickup)\b/i,
        /\b(4x4|suv|jeep|motorcycle|motorbike|scooter|moped|tuk\s*tuk|rickshaw)\b/i,
        /\b(roof\s+rack|rack|bars|ladder)\b/i,
    ],
    architecture: [
        /\b(building|buildings|house|houses|home|homes)\b/i,
        /\b(architecture|architectural)\b/i,
        /\b(stone|brick|concrete|wooden)\s+(building|house|structure)\b/i,
        /\b(roof|roofs|rooftop)\b/i,
        /\b(tower|towers|church|mosque|temple|cathedral)\b/i,
        /\b(colonial|modern|traditional|historic)\b/i,
        /\b(fence|fences|wall|walls|gate|gates)\b/i,
        /\b(style|styles)\b.*\b(building|house|architecture)\b/i,
    ],
    soil: [
        /\b(soil|terrain|ground|floor)\b/i,
        /\b(dirt|dirty|dust|dusty|mud|muddy|grime|grimy)\b(?!(.*\b(camera|lens)\b))/i,
        /\b(roof\s+dust|dirty\s+roof|dusty\s+roof|dirt\s+on\s+roof)\b/i,
        /\b(dirt\s+road|dirt\s+track)\b/i,
        /\b(muddy|dusty|sandy|rocky)\s+road\b/i,
        /\b(splatter|splash|splashed)\b/i,
    ],
    road: [
        /\b(road|roads|highway|highways|motorway)\b/i,
        /\b(pavement|asphalt|tarmac|gravel|unpaved|paved)\b/i,
        /\b(road\s+line|road\s+lines|center\s+line|outer\s+line|yellow\s+line|white\s+line)\b/i,
        /\b(lane|lanes|shoulder|median|divider)\b/i,
        /\b(intersection|junction|roundabout)\b/i,
        /\b(bridge|tunnel|overpass|underpass)\b/i,
        /\b(curb|curbs|kerb|kerbs|sidewalk|pavement)\b/i,
        /\b(guardrail|guardrails|barrier|barriers)\b/i,
        /\b(divided\s+highway|dual\s+carriageway)\b/i,
    ],
    camera: [
        /\b(camera|cameras|smallcam|lowcam|shitcam|dashcam)\b/i,
        /\b(gen(?:eration)?\s*[1-4])\b(?!.*\b(motorcycle|motorbike|scooter|car|pickup)\b)/i,
        /\b(gen(?:eration)?\s*[1-4]|shitcam|smallcam|lowcam)\s+coverage/i,
        /\b(copyright|watermark)\b/i,
        /\b(panorama|360|fisheye)\b/i,
        /\b(tripod|mounted)\b/i,
        /\b(quality|resolution|low\s+quality|high\s+quality)\b/i,
        /\b(grainy|sharp|overexposed|underexposed)\b/i,
        /\b(glare|flare|halo|reflection)\b/i,
        /\b(exposure|haze|hazy|foggy)\b/i,
        /\b(blur|blurred|unblurred)\b/i,
        /\b(smudge|smear|stain|smudges|smears|stains)\b/i,
        /\b(dust\s+on\s+camera|dirt\s+on\s+camera|dirty\s+camera|smudge\s+on\s+camera)\b/i,
        /\b(droplet|water\s+on\s+camera)\b/i,
        /\b(camera\s+angle|camera\s+tilt|camera\s+orientation|camera\s+height|camera\s+position)\b/i,
        /\b(tilted|angled)\s+camera\b/i,
        /\b(fisheye|wide\s+angle)\b/i,
    ],
    structures: [
        /\b(silo|silos)\b/i,
        /\b(water\s+tower|water\s+towers)\b/i,
        /\b(strange\s+house|strange\s+building|strange\s+architecture)\b/i,
        /\b(hut|huts|shack|shacks|cabin|cabins)\b/i,
        /\b(monument|statue|sculpture)\b/i,
        /\b(lighthouse|lighthouses)\b/i,
        /\b(hangar|hangars|warehouse|warehouses)\b/i,
    ],
};

function determineTags(title, description, note) {
    const allText = `${title || ''} ${description || ''} ${note || ''}`.toLowerCase();
    const isVehicleBlur = /\b(car|roof|motorbike|motorcycle|scooter)\b.*\b(blur|blurred|unblurred)\b/i.test(allText)
        || /\b(blur|blurred|unblurred)\b.*\b(car|roof|motorbike|motorcycle|scooter)\b/i.test(allText);

    const tags = [];
    for (const [tag, patterns] of Object.entries(TAG_PATTERNS)) {
        for (const pattern of patterns) {
            if (!pattern.test(allText)) continue;
            if (tag === 'camera' && pattern.source.includes('blur') && isVehicleBlur) continue;
            tags.push(tag);
            break;
        }
    }
    return tags;
}

function parseArgs(argv) {
    return {
        dryRun: argv.includes('--dry-run'),
        country: getLowerCaseArg(argv, '--country='),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = readJson(PLONKIT_METAS_PATH);
    const stats = Object.fromEntries([...Object.keys(TAG_PATTERNS), '(none)'].map((tag) => [tag, 0]));

    let count = 0;
    for (const countryData of data) {
        const countryKey = String(countryData.slug || countryData.country || '').toLowerCase();
        if (args.country && countryKey !== args.country && String(countryData.country || '').toLowerCase() !== args.country) continue;

        for (const meta of countryData.metas || []) {
            const tags = determineTags(meta.title, meta.description, meta.note);
            meta.tags = tags;
            if (tags.length) tags.forEach((tag) => { stats[tag] += 1; });
            else stats['(none)'] += 1;
            count += 1;
        }
    }

    console.log('TAG DISTRIBUTION');
    Object.entries(stats)
        .sort((a, b) => b[1] - a[1])
        .forEach(([tag, value]) => console.log(`${tag.padEnd(15)} ${String(value).padStart(5)}`));
    console.log(`Total: ${count} metas processed`);

    if (args.dryRun) {
        console.log('Dry run: no files written.');
        return;
    }

    writeJsonAscii(PLONKIT_METAS_PATH, data);
    console.log(`Saved tags to ${PLONKIT_METAS_PATH}`);
}

if (require.main === module) main();

module.exports = {
    determineTags,
};
