#!/usr/bin/env node
/**
 * Retrieval evaluation harness.
 *
 * Answers one question: when a quiz question comes in, does the pipeline put
 * the chunk that actually contains the answer in front of the model?
 *
 * The eval set (data/eval/<course>-eval.json) carries, for every question,
 * the chunk it was authored from (goldChunkId). We embed the questions once
 * — a single batched OpenAI call, about $0.0001 for 30 questions — and then
 * every strategy comparison is pure local CPU, so experimenting is free.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/eval-retrieval.js [course]
 *
 * Metrics
 *   recall@1 / recall@k : gold chunk is the top hit / among the top k
 *   section recall      : any chunk of the gold SECTION is among the top k
 *                         (what matters in practice: right material, even if
 *                         the answer sits in the neighbouring split)
 *   MRR                 : 1/rank of the gold chunk, averaged
 */

const fs = require('fs');
const path = require('path');
const { getQueryEmbeddings } = require('../api/search');
const { isTableOfContents } = require('../api/data-loader');

const COURSE = process.argv[2] || 'marketing';
const TOP_K = 4;
const PROC_DIR = path.join(__dirname, '..', 'data', 'processed', COURSE);
const EVAL_FILE = path.join(__dirname, '..', 'data', 'eval', `${COURSE}-eval.json`);
const CACHE_FILE = path.join(__dirname, '..', 'data', 'eval', `.${COURSE}-query-embeddings.json`);

function loadChunks() {
    const chunks = [];
    for (let i = 0; ; i++) {
        const f = path.join(PROC_DIR, `chunks_${i}.json`);
        if (!fs.existsSync(f)) break;
        chunks.push(...JSON.parse(fs.readFileSync(f, 'utf-8')));
    }
    return chunks.filter(c => !isTableOfContents(c));
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const sectionKey = (s) => (s || '').replace(/\d+$/, '').trim();

/** Query text variants we want to compare. */
const QUERY_MODES = {
    'domanda+opzioni': q => `${q.text} ${Object.values(q.options).join(' ')}`,
    'solo domanda': q => q.text
};

/**
 * Rank chunks for one query, optionally capping how many hits may come from
 * the same section (diversity), which is the change we want evidence for.
 */
function retrieve(queryEmbedding, embChunks, { topK, perSectionCap, sectionById }) {
    const scored = embChunks
        .map(c => ({ c, s: cosine(queryEmbedding, c.embedding) }))
        .sort((a, b) => b.s - a.s);

    if (!perSectionCap) return scored.slice(0, topK);

    const used = new Map();
    const out = [];
    for (const item of scored) {
        const sec = sectionKey(sectionById.get(item.c.id));
        const n = used.get(sec) || 0;
        if (n >= perSectionCap) continue;
        used.set(sec, n + 1);
        out.push(item);
        if (out.length === topK) break;
    }
    return out;
}

function evaluate(questions, queryEmbeddings, embChunks, sectionById, opts) {
    let r1 = 0, rk = 0, secHit = 0, mrrSum = 0;
    const misses = [];

    questions.forEach((q, i) => {
        const hits = retrieve(queryEmbeddings[i], embChunks, { ...opts, sectionById });
        const ids = hits.map(h => h.c.id);
        const rank = ids.indexOf(q.goldChunkId);

        if (rank === 0) r1++;
        if (rank >= 0) { rk++; mrrSum += 1 / (rank + 1); }
        else misses.push(q);

        const goldSec = sectionKey(q.goldSection) || sectionKey(sectionById.get(q.goldChunkId));
        if (hits.some(h => sectionKey(sectionById.get(h.c.id)) === goldSec)) secHit++;
    });

    const n = questions.length;
    return {
        recall1: r1 / n,
        recallK: rk / n,
        sectionRecall: secHit / n,
        mrr: mrrSum / n,
        misses
    };
}

const pct = v => (v * 100).toFixed(0).padStart(3) + '%';

async function main() {
    if (!fs.existsSync(EVAL_FILE)) {
        console.error(`Eval set non trovato: ${EVAL_FILE}`);
        process.exit(1);
    }
    const evalSet = JSON.parse(fs.readFileSync(EVAL_FILE, 'utf-8'));
    const questions = evalSet.questions;

    const textChunks = loadChunks();
    const sectionById = new Map(textChunks.map(c => [c.id, c.section]));

    const embFile = path.join(PROC_DIR, 'embeddings.json');
    if (!fs.existsSync(embFile)) {
        console.error(`embeddings.json non trovato per ${COURSE}`);
        process.exit(1);
    }
    const embChunks = JSON.parse(fs.readFileSync(embFile, 'utf-8'))
        .chunks.filter(c => !isTableOfContents(c));

    console.log(`\nCorso: ${COURSE} · ${embChunks.length} chunk · ${questions.length} domande di valutazione\n`);

    // Query embeddings are cached on disk: the API is touched once, then every
    // subsequent experiment is free.
    let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) : {};
    const results = {};

    for (const [modeName, buildQuery] of Object.entries(QUERY_MODES)) {
        const texts = questions.map(buildQuery);
        const cacheKey = `${modeName}::${evalSet.version}`;

        if (!cache[cacheKey] || cache[cacheKey].length !== texts.length) {
            if (!process.env.OPENAI_API_KEY) {
                console.error('OPENAI_API_KEY non impostata: impossibile calcolare gli embedding delle domande.');
                console.error('Esegui:  export OPENAI_API_KEY="sk-..."  e rilancia.');
                process.exit(1);
            }
            process.stdout.write(`Embedding domande (${modeName})... `);
            const vecs = await getQueryEmbeddings(texts);
            if (!vecs) { console.error('fallito.'); process.exit(1); }
            cache[cacheKey] = vecs;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
            console.log('fatto (in cache per le prossime esecuzioni)');
        }

        const qEmb = cache[cacheKey];
        results[`${modeName} · k=${TOP_K}`] = evaluate(questions, qEmb, embChunks, sectionById, { topK: TOP_K });
        results[`${modeName} · k=${TOP_K} · max 2 per sezione`] =
            evaluate(questions, qEmb, embChunks, sectionById, { topK: TOP_K, perSectionCap: 2 });
        if (modeName === 'domanda+opzioni') {
            results[`${modeName} · k=3`] = evaluate(questions, qEmb, embChunks, sectionById, { topK: 3 });
        }
    }

    const label = 'strategia'.padEnd(44);
    console.log(`${label} recall@1  recall@k  sezione   MRR`);
    console.log('-'.repeat(80));
    for (const [name, r] of Object.entries(results)) {
        console.log(`${name.padEnd(44)} ${pct(r.recall1)}      ${pct(r.recallK)}     ${pct(r.sectionRecall)}   ${r.mrr.toFixed(2)}`);
    }

    const base = results[`domanda+opzioni · k=${TOP_K}`];
    if (base?.misses.length) {
        console.log(`\nDomande in cui il chunk corretto NON entra nei top ${TOP_K} (configurazione attuale):`);
        base.misses.forEach(q => console.log(`  ${q.id} [${q.area}] ${q.text.substring(0, 70)}...`));
    } else {
        console.log(`\nNessuna domanda mancata nella configurazione attuale.`);
    }
    console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
