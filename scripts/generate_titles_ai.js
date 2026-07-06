const fs = require('fs');
const path = require('path');
const { stringifyJsonAscii } = require('./json_utils');

const PLONKIT_METAS_PATH = path.join(__dirname, '../data/plonkit_metas.json');
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e2b';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

function parseArgs(argv) {
    return {
        provider: getArg(argv, '--provider=') || process.env.TITLE_PROVIDER || 'ollama',
        model: getArg(argv, '--model=') || null,
        limit: parseIntArg(argv, '--limit='),
        country: (getArg(argv, '--country=') || '').toLowerCase() || null,
        dryRun: argv.includes('--dry-run'),
        force: argv.includes('--force'),
    };
}

function getArg(argv, prefix) {
    const arg = argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length).trim() : null;
}

function parseIntArg(argv, prefix) {
    const value = getArg(argv, prefix);
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildPrompt(meta) {
    return `You write concise GeoGuessr meta titles.

Return ONLY valid JSON in this shape:
{"title":"Short Title"}

Rules:
- 2 to 5 words.
- Maximum 42 characters.
- Title Case.
- No country name unless needed to disambiguate.
- No punctuation except hyphen when natural.
- Describe the visual clue, not the whole sentence.
- Do not invent information.

Country: ${meta.country}
Section: ${meta.section}
Description: ${meta.description}
Note: ${meta.note || ''}`;
}

function extractJsonObject(text) {
    const trimmed = String(text || '').trim();
    try {
        return JSON.parse(trimmed);
    } catch (_) {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`Model did not return JSON: ${trimmed.slice(0, 120)}`);
        return JSON.parse(match[0]);
    }
}

function cleanTitle(title) {
    const cleaned = String(title || '')
        .replace(/["'`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) throw new Error('Empty title');
    if (cleaned.length > 48) throw new Error(`Title too long: ${cleaned}`);
    if (cleaned.split(/\s+/).length > 7) throw new Error(`Title has too many words: ${cleaned}`);
    return cleaned;
}

async function generateWithOllama(meta, model) {
    const response = await fetch(`${DEFAULT_OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            prompt: buildPrompt(meta),
            stream: false,
            format: 'json',
            options: {
                temperature: 0.1,
                num_predict: 80,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return cleanTitle(extractJsonObject(data.response).title);
}

async function generateWithOpenAI(meta, model) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model,
            input: buildPrompt(meta),
            text: {
                format: {
                    type: 'json_schema',
                    name: 'meta_title',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            title: { type: 'string' },
                        },
                        required: ['title'],
                    },
                },
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`OpenAI returned HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.output_text
        || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
    return cleanTitle(extractJsonObject(text).title);
}

async function generateTitle(meta, args) {
    if (args.provider === 'openai') {
        return generateWithOpenAI(meta, args.model || DEFAULT_OPENAI_MODEL);
    }
    if (args.provider === 'ollama') {
        return generateWithOllama(meta, args.model || DEFAULT_OLLAMA_MODEL);
    }
    throw new Error(`Unsupported provider: ${args.provider}`);
}

function collectTargets(data, args) {
    const targets = [];
    for (const country of data) {
        const countryKey = String(country.slug || country.country || '').toLowerCase();
        if (args.country && countryKey !== args.country && String(country.country || '').toLowerCase() !== args.country) {
            continue;
        }

        for (const meta of country.metas || []) {
            if (!args.force && meta.title) continue;
            targets.push({ country, meta });
            if (args.limit && targets.length >= args.limit) return targets;
        }
    }
    return targets;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = JSON.parse(fs.readFileSync(PLONKIT_METAS_PATH, 'utf8'));
    const targets = collectTargets(data, args);

    console.log(`Provider: ${args.provider}`);
    console.log(`Model: ${args.model || (args.provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_OLLAMA_MODEL)}`);
    console.log(`Targets: ${targets.length}`);

    let generated = 0;
    let failed = 0;

    for (const [index, target] of targets.entries()) {
        const { meta } = target;
        const oldTitle = meta.title || '';
        try {
            const title = await generateTitle(meta, args);
            meta.title = title;
            generated += 1;
            console.log(`[${index + 1}/${targets.length}] ${meta.country}: ${oldTitle || '(empty)'} -> ${title}`);
        } catch (err) {
            failed += 1;
            console.error(`[${index + 1}/${targets.length}] ${meta.country}: ${err.message}`);
        }
    }

    console.log(`Generated: ${generated}`);
    console.log(`Failed: ${failed}`);

    if (args.dryRun) {
        console.log('Dry run: no files written.');
        return;
    }

    if (generated > 0) {
        fs.writeFileSync(PLONKIT_METAS_PATH, stringifyJsonAscii(data));
        console.log(`Saved titles to ${PLONKIT_METAS_PATH}`);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
});
