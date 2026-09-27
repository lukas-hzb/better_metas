const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, '..', 'data');
const read = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));

// Plonk It stores metas inside country groups; also support flattened exports.
const systemMetas = read('plonkit_metas.json').flatMap(entry => {
    if (entry && entry.id) return [entry];
    if (Array.isArray(entry)) return entry;
    return entry && Array.isArray(entry.metas) ? entry.metas : [];
});
const metaIds = new Set([...systemMetas, ...read('user_metas.json')]
    .filter(meta => meta && typeof meta.id === 'string' && meta.id.trim())
    .map(meta => meta.id));
const panoIds = new Set([
    ...Object.keys(read('plonkit_locations.json')),
    ...Object.keys(read('user_locations.json')),
]);

const stats = { metas: metaIds.size, locations: panoIds.size };
fs.writeFileSync(path.join(dataDir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
console.log(`Updated stats: ${stats.metas} metas, ${stats.locations} locations.`);
