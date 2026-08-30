#!/usr/bin/env node
/**
 * Confronta due modelli sul passo di ESTRAZIONE (OCR) usando fotografie vere.
 *
 * La metrica non e' "ha letto bene le parole", che si puo' solo giudicare a
 * occhio, ma quella che conta davvero a valle: quante domande fotografate
 * agganciano ancora il question bank e con quale lettera. Una trascrizione
 * imprecisa non sbaglia la risposta, la fa scivolare fuori dal Tier 1 - gratis
 * e certificato - dentro la pipeline RAG, e nei casi peggiori fa rimappare la
 * lettera sull'opzione sbagliata.
 *
 * Il foglio fotografato ha le opzioni permutate rispetto al bank, quindi il
 * rimappaggio meccanico viene esercitato davvero. La verita' di riferimento
 * (data/eval/extraction-sheet-groundtruth.json) porta la lettera corretta COME
 * STAMPATA, ed e' quella che confrontiamo.
 *
 * Uso: node scripts/eval-extraction.js <corso> <foto.jpg...> [--models sonnet,opus]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MODELS = flag('models', 'sonnet,opus').split(',');
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--models'));
const courseName = positional[0];
const photos = positional.slice(1);

if (!courseName || !photos.length) {
    console.error('Uso: node scripts/eval-extraction.js <corso> <foto.jpg...> [--models sonnet,opus]');
    process.exit(1);
}
process.env.COURSE_NAME = courseName;

const { extractQuestions } = require('../api/claude-client');
const { buildExtractionPrompt } = require('../api/response-builder');
const { parseQuestionsWithStats } = require('../api/question-parser');
const { lookupQuestions, normalize } = require('../api/question-bank');

const truth = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'eval', 'extraction-sheet-groundtruth.json'), 'utf-8'));
const byNum = new Map(truth.questions.map(q => [q.n, q]));

// Fedelta' del testo: quanto la trascrizione somiglia all'originale stampato,
// indipendentemente dal bank. Serve a distinguere "ha letto male" da "ha letto
// bene ma il bank non aggancia".
function fidelity(a, b) {
    const ta = new Set(normalize(a).split(' ').filter(t => t.length > 2));
    const tb = new Set(normalize(b).split(' ').filter(t => t.length > 2));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
}

const mediaType = (p) => (/\.png$/i.test(p) ? 'image/png' : 'image/jpeg');

(async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
    if (!apiKey) { console.error('[eval-extraction] ANTHROPIC_API_KEY_EVO non impostata'); process.exit(1); }

    const totals = {};
    MODELS.forEach(m => { totals[m] = { estratte: 0, numeri: 0, tier1: 0, tier1ok: 0, tier2: 0, tier3: 0, scartate: 0, parziali: 0, troncate: 0, fedelta: [], costo: 0, dettaglio: [] }; });

    for (const photo of photos) {
        const data = fs.readFileSync(photo).toString('base64');
        const imageContent = { type: 'image', source: { type: 'base64', media_type: mediaType(photo), data } };
        console.log(`\n=== ${path.basename(photo)} ===`);

        for (const modelKey of MODELS) {
            const t = totals[modelKey];
            let res;
            try {
                res = await extractQuestions(apiKey, imageContent, buildExtractionPrompt(), modelKey);
            } catch (e) {
                console.log(`  ${modelKey.padEnd(7)} ERRORE: ${e.message}`);
                continue;
            }
            t.costo += res.cost || 0;

            const parsed = parseQuestionsWithStats(res.text);
            t.estratte += parsed.questions.length;
            t.scartate += parsed.dropped; t.parziali += parsed.illegible; t.troncate += parsed.truncated;

            const look = lookupQuestions(parsed.questions, courseName);
            const tierOf = new Map();
            look.direct.forEach(d => tierOf.set(d.questionIndex, { tier: 1, letter: d.remappedLetter, score: d.score }));
            look.needsHaiku.forEach(h => tierOf.set(h.questionIndex, { tier: 2, score: h.score }));
            look.unmatched.forEach(i => tierOf.set(i, { tier: 3 }));

            let ok = 0, t1 = 0, t2 = 0, t3 = 0, nums = 0;
            parsed.questions.forEach((q, i) => {
                const info = tierOf.get(i) || { tier: 3 };
                if (info.tier === 1) t1++; else if (info.tier === 2) t2++; else t3++;
                const gt = byNum.get(q.printedNumber);
                if (gt) {
                    nums++;
                    t.fedelta.push(fidelity(q.text, gt.text));
                    if (info.tier === 1 && info.letter === gt.expected) ok++;
                    if (info.tier === 1 && info.letter !== gt.expected) {
                        t.dettaglio.push(`n${q.printedNumber}: tier1 ha dato ${info.letter}, stampata ${gt.expected}`);
                    }
                }
            });
            t.numeri += nums; t.tier1 += t1; t.tier1ok += ok; t.tier2 += t2; t.tier3 += t3;
            console.log(`  ${modelKey.padEnd(7)} ${parsed.questions.length} domande · numeri riconosciuti ${nums} · tier1 ${t1} (giuste ${ok}) · tier2 ${t2} · tier3 ${t3}` +
                        (parsed.dropped || parsed.illegible || parsed.truncated ? ` · scartate ${parsed.dropped}/parziali ${parsed.illegible}/troncate ${parsed.truncated}` : ''));
        }
    }

    console.log('\n\n=========== RIEPILOGO ===========');
    console.log(`foglio di riferimento: ${truth.count} domande stampate\n`);
    MODELS.forEach(m => {
        const t = totals[m];
        const fid = t.fedelta.length ? t.fedelta.reduce((a, b) => a + b, 0) / t.fedelta.length : 0;
        console.log(`${m.toUpperCase()}`);
        console.log(`  domande estratte        ${t.estratte}/${truth.count}`);
        console.log(`  numero stampato letto   ${t.numeri}/${truth.count}`);
        console.log(`  fedelta media del testo ${(fid * 100).toFixed(1)}%`);
        console.log(`  tier 1 (gratis)         ${t.tier1}   di cui lettera giusta ${t.tier1ok}`);
        console.log(`  tier 2 / tier 3         ${t.tier2} / ${t.tier3}`);
        if (t.scartate || t.parziali || t.troncate) console.log(`  perse in parsing        scartate ${t.scartate}, parziali ${t.parziali}, troncate ${t.troncate}`);
        t.dettaglio.forEach(d => console.log(`  ATTENZIONE ${d}`));
        console.log(`  costo                   $${t.costo.toFixed(4)}\n`);
    });
})().catch(e => { console.error('[eval-extraction] errore:', e.message); process.exit(1); });
