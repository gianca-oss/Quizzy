#!/usr/bin/env node
/**
 * Accuratezza end-to-end della sola pipeline RAG.
 *
 * Le domande del question bank hanno una risposta corretta certificata, quindi
 * sono un banco di prova migliore delle trenta gold hand-authored: misurano la
 * lettera finale invece del recupero del chunk, che e' solo una tappa.
 *
 * Il question bank viene SCAVALCATO di proposito: a runtime queste domande
 * uscirebbero a Tier 1 senza toccare il RAG, e non e' quello che vogliamo
 * misurare. Quello che vogliamo sapere e' come se la cava il RAG da solo su
 * domande di questo corso e di questa difficolta', perche' e' esattamente il
 * lavoro che gli tocchera' sulle domande d'esame che nel bank non ci sono.
 *
 * Il campione e' deterministico (passo fisso, nessun random): due esecuzioni su
 * corpus diversi vedono le stesse domande, altrimenti il confronto non vale.
 *
 * ATTENZIONE: perche' la misura sia onesta il corpus NON deve contenere i
 * materiali d'esame. Se domande e soluzioni sono nei chunk, il modello le
 * ritrova gia' scritte nel contesto e il punteggio non significa niente.
 *
 * Uso:
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY_EVO=... \
 *     node scripts/eval-answers.js marketing --limit 100 --label baseline
 *   node scripts/eval-answers.js marketing --limit 100 --dry   (nessuna spesa)
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const courseName = args.find(a => !a.startsWith('--'));
const flag = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const DRY = args.includes('--dry');
// Controllo: stesse domande, contesto vuoto. Misura quanto il modello risponde
// da solo, senza corpus. E' il pavimento sotto cui nessuna configurazione di
// retrieval puo' scendere, e soprattutto dice quanto margine c'e' per
// distinguere un corpus dall'altro: se il controllo fa 90%, un confronto fra
// due corpus si gioca su dieci domande e non misura quasi niente.
const NO_CONTEXT = args.includes('--no-context');
const LIMIT = parseInt(flag('limit', '100'), 10);
const BATCH = parseInt(flag('batch', '10'), 10);
const MODEL = flag('model', 'sonnet');
const LABEL = flag('label', DRY ? 'dry' : 'run');

if (!courseName) {
    console.error('Uso: node scripts/eval-answers.js <corso> [--limit N] [--batch N] [--model sonnet|opus] [--label nome] [--dry]');
    process.exit(1);
}
process.env.COURSE_NAME = courseName;

const { loadEnhancedData, loadEmbeddings } = require('../api/data-loader');
const { hybridSearch } = require('../api/search');
const { analyzeWithContext, maxTokensForQuestions } = require('../api/claude-client');
const { buildAnalysisPrompt, buildRagContextWithStats, parseAnswers } = require('../api/response-builder');

// Passo fisso: preleva un campione sparso su tutto il bank invece dei primi N,
// che verrebbero tutti dallo stesso corso.
function sample(items, limit) {
    if (!limit || limit >= items.length) return items.map((q, i) => ({ q, idx: i }));
    const stride = items.length / limit;
    const out = [];
    for (let k = 0; k < limit; k++) out.push({ q: items[Math.floor(k * stride)], idx: Math.floor(k * stride) });
    return out;
}

(async () => {
    const bankPath = path.join(__dirname, '..', 'data', 'processed', courseName, 'question-bank.json');
    if (!fs.existsSync(bankPath)) {
        console.error(`[eval-answers] nessun question bank per "${courseName}"`);
        process.exit(1);
    }
    const bank = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));

    const data = await loadEnhancedData();
    if (!data?.textChunks?.length) {
        console.error('[eval-answers] corpus non caricato');
        process.exit(1);
    }
    const embeddingsData = await loadEmbeddings();

    // hybridSearch ripiega sulle parole chiave se manca la chiave OpenAI, senza
    // fallire. In produzione il percorso e' semantico: misurare quello keyword e
    // chiamarlo baseline darebbe un numero che non descrive niente di reale.
    if (!NO_CONTEXT && embeddingsData && !process.env.OPENAI_API_KEY && !args.includes('--keyword')) {
        console.error('[eval-answers] il corpus ha gli embeddings ma OPENAI_API_KEY non e\' impostata:');
        console.error('               la ricerca ripiegherebbe sulle parole chiave e la misura non');
        console.error('               descriverebbe il percorso di produzione. Esporta la chiave,');
        console.error('               oppure passa --keyword per misurare apposta quel percorso.');
        process.exit(1);
    }
    if (!DRY && !process.env.ANTHROPIC_API_KEY_EVO) {
        console.error('[eval-answers] ANTHROPIC_API_KEY_EVO non impostata: senza non si puo\' analizzare.');
        process.exit(1);
    }

    const picked = sample(bank.questions, LIMIT);
    console.log(`[eval-answers] corso ${courseName} · ${data.textChunks.length} chunk · embeddings ${embeddingsData ? 'sì' : 'NO (solo keyword)'}`);
    console.log(`[eval-answers] ${picked.length} domande su ${bank.questions.length}, a lotti da ${BATCH}, modello ${MODEL}${DRY ? ' · DRY RUN' : ''}${NO_CONTEXT ? ' · SENZA CONTESTO (controllo)' : ''}\n`);

    const results = [];
    let cost = 0;
    let promptChars = 0;
    const retrieval = { uniqueChunks: 0, contextChars: 0, batches: 0 };

    for (let i = 0; i < picked.length; i += BATCH) {
        const slice = picked.slice(i, i + BATCH);
        const questions = slice.map(s => ({ text: s.q.question, options: s.q.options }));
        const nums = slice.map(s => s.idx + 1);

        let context = '';
        let stats = { uniqueChunks: 0, contextChars: 0 };
        if (!NO_CONTEXT) {
            const searchResults = await hybridSearch(questions, data.textChunks, embeddingsData);
            ({ context, stats } = buildRagContextWithStats(
                questions.map((q, k) => ({ num: nums[k], result: searchResults[k] }))
            ));
        }
        retrieval.uniqueChunks += stats.uniqueChunks;
        retrieval.contextChars += stats.contextChars;
        retrieval.batches++;

        const prompt = buildAnalysisPrompt(
            context,
            questions.map((q, k) => ({ num: nums[k], text: q.text, options: q.options }))
        );
        promptChars += prompt.length;

        if (DRY) {
            process.stdout.write(`  lotto ${retrieval.batches}: ${stats.uniqueChunks} chunk unici, ${Math.round(stats.contextChars / 1000)}k char di contesto\n`);
            continue;
        }

        const res = await analyzeWithContext(process.env.ANTHROPIC_API_KEY_EVO, prompt, MODEL, { maxTokens: maxTokensForQuestions(questions.length) });
        cost += res.cost || 0;
        const { answers } = parseAnswers(res.text, context);

        slice.forEach((s, k) => {
            const got = answers[nums[k]] || { letter: '?', source: 'assente' };
            results.push({
                idx: s.idx,
                sezione: s.q.sourceSection,
                numero: s.q.sourceNum,
                domanda: s.q.question,
                attesa: s.q.correct,
                ottenuta: got.letter,
                fonte: got.source,
                giusta: got.letter === s.q.correct
            });
        });
        const ok = results.filter(r => r.giusta).length;
        process.stdout.write(`  ${results.length}/${picked.length} · giuste ${ok} (${Math.round(100 * ok / results.length)}%) · $${cost.toFixed(3)}\n`);
    }

    console.log(`\n[eval-answers] recupero: ${(retrieval.uniqueChunks / retrieval.batches).toFixed(1)} chunk unici per lotto · ${Math.round(retrieval.contextChars / retrieval.batches / 1000)}k char di contesto medio`);

    if (DRY) {
        const tokens = Math.round(promptChars / 3.6);
        console.log(`[eval-answers] prompt totali: ${Math.round(promptChars / 1000)}k caratteri ≈ ${Math.round(tokens / 1000)}k token in ingresso`);
        console.log(`[eval-answers] stima prudenziale (Sonnet a 3$/M in ingresso, 15$/M in uscita): $${(tokens / 1e6 * 3 + retrieval.batches * 3000 / 1e6 * 15).toFixed(2)}`);
        return;
    }

    const ok = results.filter(r => r.giusta).length;
    const noAnswer = results.filter(r => r.ottenuta === '?').length;
    const bySource = results.reduce((a, r) => { a[r.fonte] = (a[r.fonte] || 0) + 1; return a; }, {});
    const bySection = {};
    results.forEach(r => {
        bySection[r.sezione] = bySection[r.sezione] || { tot: 0, ok: 0 };
        bySection[r.sezione].tot++;
        if (r.giusta) bySection[r.sezione].ok++;
    });

    console.log(`\n=== ${LABEL} ===`);
    console.log(`accuratezza      ${ok}/${results.length}  (${(100 * ok / results.length).toFixed(1)}%)`);
    console.log(`senza risposta   ${noAnswer}`);
    console.log(`fonti dichiarate ${JSON.stringify(bySource)}`);
    Object.entries(bySection).forEach(([s, v]) =>
        console.log(`  sezione ${s}: ${v.ok}/${v.tot} (${Math.round(100 * v.ok / v.tot)}%)`));
    console.log(`costo            $${cost.toFixed(3)}`);

    const outPath = path.join(__dirname, '..', 'data', 'eval', `${courseName}-answers-${LABEL}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        course: courseName, label: LABEL, model: MODEL, noContext: NO_CONTEXT,
        corpusChunks: data.textChunks.length, embeddings: !!embeddingsData,
        sampled: results.length, correct: ok, accuracy: ok / results.length,
        cost, results
    }, null, 2) + '\n', 'utf-8');
    console.log(`salvato ${outPath}`);
})().catch(e => { console.error('[eval-answers] errore:', e.message); process.exit(1); });
