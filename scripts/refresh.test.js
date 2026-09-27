const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeScrapedData, flattenGuideItems } = require('../scraper');
const { extractMapsLocation, mergeLocation, isMapsUrl, textMapsLinks } = require('./extract_guide_locations');

const meta = (id, extra = {}) => ({ id, plonkitId: id, description: `Clue ${id}`,
    country: 'Test', section: 'Step 1', note: '',
    title: 'Curated Title', imageUrl: `https://www.plonkit.net/images/test/${id}.png`,
    scope: 'region', tags: ['road'], addedAt: '2020-01-01', ...extra });
const country = metas => ({ country: 'Test', slug: 'test', metas });
const merge = (old, fresh) => mergeScrapedData([country(old)], [country(fresh)]);

test('changed clues keep IDs, curated fields, custom metadata and absent upstream entries', () => {
    const old = meta('custom-id', { plonkitId: 'upstream', custom: 'keep' });
    const local = meta('local', { plonkitId: undefined });
    const result = merge([old, local], [meta('canonical-id', { plonkitId: 'upstream', description: 'Changed clue', title: '', scope: 'countrywide' })]);
    assert.equal(result.stats.updated, 1);
    assert.deepEqual(result.data[0].metas.map(m => m.id), ['custom-id', 'local']);
    assert.equal(result.data[0].metas[0].description, 'Changed clue');
    for (const field of ['title', 'scope', 'tags', 'addedAt', 'custom']) assert.deepEqual(result.data[0].metas[0][field], old[field]);
});

test('reused image paths do not merge unrelated clues', () => {
    const old = meta('old');
    const result = merge([old], [meta('new', { imageUrl: old.imageUrl })]);
    assert.equal(result.stats.added, 1);
    assert.equal(result.data[0].metas.length, 2);
});

test('unique text match handles changed upstream IDs without breaking location references', () => {
    const result = merge([meta('old')], [meta('new', { description: 'Clue old' })]);
    assert.equal(result.data[0].metas[0].id, 'old');
    assert.equal(result.data[0].metas[0].plonkitId, 'new');
});

test('fallback cannot steal a later exact match, or merge ambiguous text', () => {
    const result = merge([meta('old')], [meta('new', { description: 'Clue old' }), meta('old')]);
    assert.equal(result.data[0].metas.length, 2);
    assert.equal(result.stats.unchanged, 1);
    const ambiguous = merge([meta('a', { description: 'same' }), meta('b', { description: 'same' })], [meta('c', { description: 'same' })]);
    assert.equal(ambiguous.data[0].metas.length, 3);
});

test('repeat import is unchanged', () => {
    const old = meta('same');
    assert.equal(merge([old], [old]).stats.unchanged, 1);
});

test('intentional empty tags and missing historical timestamps are preserved', () => {
    const old = meta('same', { tags: [] });
    delete old.addedAt;
    const result = merge([old], [meta('same')]);
    assert.deepEqual(result.data[0].metas[0].tags, []);
    assert.equal('addedAt' in result.data[0].metas[0], false);
    assert.equal(result.stats.unchanged, 1);
});

test('duplicate source IDs abort the merge', () => {
    assert.throws(() => merge([], [meta('same'), meta('same')]), /duplicate meta ID/);
});

test('source warning markup is removed without losing its text', () => {
    const result = flattenGuideItems({ slug: 'test', title: 'Test', steps: [{ items: [
        { kind: 'tip', id: 'a', data: { text: ['!!Similar clues exist elsewhere.'] } },
    ] }] });
    assert.equal(result.metas[0].description, 'Similar clues exist elsewhere.');
});

test('location merge preserves previous links and extra fields including legacy arrays', () => {
    const locations = { a: { metas: ['old'], custom: 'keep' }, b: ['old'] };
    for (const id of ['a', 'b']) {
        mergeLocation(locations, id, { metaId: 'new', country: 'Test' }, { lat: 0, lng: 0 });
        mergeLocation(locations, id, { metaId: 'new', country: 'Test' }, { lat: 0, lng: 0 });
        assert.deepEqual(locations[id].metas, ['old', 'new']);
    }
    assert.equal(locations.a.custom, 'keep');
});

test('location merge preserves curated coordinates and address fields', () => {
    const locations = { a: { metas: ['old'], lat: 0, lng: 0, country: 'Custom', region: 'Custom Region', city: null } };
    mergeLocation(locations, 'a', { metaId: 'new', country: 'Guide' }, { lat: 1, lng: 2, country: 'Guide', region: null, city: 'New City' });
    assert.deepEqual(locations.a, { metas: ['old', 'new'], lat: 0, lng: 0, country: 'Custom', region: 'Custom Region', city: 'New City' });
});

test('maps parser accepts zero and rejects invalid coordinates and malformed encoding', () => {
    assert.deepEqual(extractMapsLocation('https://www.google.com/maps/@0,0,3a/data=!1sabc!2e0'), { panoid: 'abc', lat: 0, lng: 0 });
    assert.deepEqual(extractMapsLocation('https://www.google.com/maps/?pano=abc&viewpoint=1%2C2'), { panoid: 'abc', lat: 1, lng: 2 });
    assert.equal(extractMapsLocation('https://www.google.com/maps/@91,0,3a/data=!1sabc'), null);
    assert.equal(extractMapsLocation('https://www.google.com/maps/%oops'), null);
    assert.equal(isMapsUrl('https://www.google.co.uk/maps/@1,2'), true);
    assert.equal(isMapsUrl('https://example.com/google.com/maps'), false);
});

test('text examples are deduplicated and reported separately from location imports', () => {
    const item = { data: { text: [
        'Compare [another country](https://goo.gl/maps/abc).',
        '[again](https://goo.gl/maps/abc) and [image](https://www.plonkit.net/images/map.png)',
    ] } };
    assert.deepEqual(textMapsLinks(item), ['https://goo.gl/maps/abc']);
});
