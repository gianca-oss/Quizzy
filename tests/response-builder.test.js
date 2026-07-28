const { test } = require('node:test');
const assert = require('node:assert');
const {
    stripLeadingNum,
    buildRagContext,
    buildRagContextWithStats,
    buildAnalysisPrompt,
    parseAnswers
} = require('../api/response-builder');

// --- stripLeadingNum() : double-number bug ----------------------------------
// OCR text often already starts with "5. ...". We must strip it so rendering
// "**N. " doesn't produce "5. 5. ..." — WITHOUT eating decimals or years.

test('stripLeadingNum removes a leading question number', () => {
    assert.strictEqual(stripLeadingNum('5. La somministrazione...'), 'La somministrazione...');
    assert.strictEqual(stripLeadingNum('12) Il lavoro agile...'), 'Il lavoro agile...');
});

test('stripLeadingNum preserves decimals and years (no trailing space)', () => {
    assert.strictEqual(stripLeadingNum('3.5 milioni di lavoratori'), '3.5 milioni di lavoratori');
    assert.strictEqual(stripLeadingNum('1990 fu un anno...'), '1990 fu un anno...');
});

// --- buildRagContext() : original numbering ---------------------------------

test('buildRagContext preserves original (non-sequential) question numbers', () => {
    const ctx = buildRagContext([
        { num: 3, result: { searchMethod: 'semantic', matches: [{ chunk: { section: '6.3', text: 'testo' } }] } },
        { num: 5, result: { matches: [] } }
    ]);
    assert.ok(ctx.includes('DOMANDA 3 - CONTESTO'));
    assert.ok(ctx.includes('DOMANDA 5 - NO CONTESTO'));
    assert.ok(!ctx.includes('DOMANDA 1'));
});

// --- buildRagContext() : dedup + full-length chunks -------------------------
// A chunk shared by several questions must appear ONCE in the library and be
// referenced by id, and it must no longer be cut at 1500 chars.

test('buildRagContext emits a shared chunk once and references it by id', () => {
    const shared = { id: 'chunk_1', section: '1.9 Transizioni', text: 'testo condiviso' };
    const other = { id: 'chunk_2', section: '2.1 Altro', text: 'altro testo' };
    const { context, stats } = buildRagContextWithStats([
        { num: 1, result: { searchMethod: 'semantic', matches: [{ chunk: shared }, { chunk: other }] } },
        { num: 2, result: { searchMethod: 'semantic', matches: [{ chunk: shared }] } }
    ]);

    assert.strictEqual(stats.uniqueChunks, 2, 'the shared chunk must not be duplicated');
    assert.strictEqual(stats.totalRefs, 3);
    assert.strictEqual(context.split('testo condiviso').length - 1, 1, 'text appears exactly once');
    assert.ok(context.includes('DOMANDA 1 - CONTESTO (semantic): M1, M2'));
    assert.ok(context.includes('DOMANDA 2 - CONTESTO (semantic): M1'));
});

test('buildRagContext keeps the top chunk full-length (no 1500-char cut)', () => {
    const long = 'x'.repeat(4000);
    const ctx = buildRagContext([
        { num: 1, result: { searchMethod: 'semantic', matches: [{ chunk: { id: 'c1', section: '1.1', text: long } }] } }
    ]);
    assert.ok(ctx.includes('x'.repeat(4000)), 'top-ranked chunk must not be truncated at 1500');
});

test('buildRagContext caps low-relevance chunks to keep the budget', () => {
    const long = 'y'.repeat(4000);
    const ctx = buildRagContext([
        {
            num: 1,
            result: {
                searchMethod: 'semantic',
                matches: [
                    { chunk: { id: 'top', section: '1.1', text: 'top' } },
                    { chunk: { id: 'c2', section: '1.2', text: 'second' } },
                    { chunk: { id: 'c3', section: '1.3', text: long } }
                ]
            }
        }
    ]);
    assert.ok(!ctx.includes('y'.repeat(1501)), 'rank-2 chunk should stay capped');
});

test('buildRagContext labels chunks with their section for citation', () => {
    const ctx = buildRagContext([
        { num: 1, result: { searchMethod: 'semantic', matches: [{ chunk: { id: 'c1', section: '3.6 L\'evoluzione', text: 't' } }] } }
    ]);
    assert.ok(ctx.includes('Sez. 3.6 L\'evoluzione'), 'section must reach the prompt so [Sez. X.Y] is answerable');
});

// --- buildAnalysisPrompt() : single source of truth -------------------------

test('buildAnalysisPrompt uses explicit numbers and never double-numbers', () => {
    const prompt = buildAnalysisPrompt('ctx', [
        { num: 3, text: '3. Domanda tre', options: { A: 'a', B: 'b', C: 'c' } },
        { num: 5, text: 'Domanda cinque', options: { A: 'a', B: 'b', C: 'c' } }
    ]);
    assert.ok(prompt.includes('3, 5'), 'prompt should instruct to use original numbers 3, 5');
    assert.ok(!prompt.includes('5. 5.'), 'must not double-number');
    assert.ok(prompt.includes('[CORRETTA]'), 'must request the [CORRETTA] marker');
});

test('buildAnalysisPrompt forceAnswer adds the never-leave-blank rule', () => {
    const base = buildAnalysisPrompt('ctx', [{ num: 1, text: 'q', options: { A: 'a', B: 'b' } }]);
    const forced = buildAnalysisPrompt('ctx', [{ num: 1, text: 'q', options: { A: 'a', B: 'b' } }], { forceAnswer: true });
    assert.ok(!base.includes('NON lasciare MAI'));
    assert.ok(forced.includes('NON lasciare MAI'));
});

// --- parseAnswers() : letter + source detection -----------------------------

test('parseAnswers reads the letter from the [CORRETTA] marker', () => {
    const resp = [
        '**2. Il lavoro agile è consentito:**',
        'A) Su iniziativa del datore',
        'B) Su iniziativa del lavoratore',
        'C) Su accordo tra le parti [CORRETTA]',
        'Spiegazione: [CITATO] "..." [Sez. 1.9].'
    ].join('\n');
    assert.strictEqual(parseAnswers(resp).answers['2'].letter, 'C');
});

test('parseAnswers tags CITATO source from a section citation', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] "x" [Sez. 6.3].';
    assert.strictEqual(parseAnswers(resp).answers['1'].source, 'CITATO');
});

test('parseAnswers tags AI source when explanation is [AI]', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [AI] non trovato.';
    assert.strictEqual(parseAnswers(resp).answers['1'].source, 'AI');
});

test('parseAnswers recovers a letter from prose when the marker is missing', () => {
    const resp = '**4. q**\nA) a\nB) b\nC) c\nSpiegazione: [AI] La risposta corretta è B perché...';
    assert.strictEqual(parseAnswers(resp).answers['4'].letter, 'B');
});

test('parseAnswers prose fallback tolerates a bare "e" connector', () => {
    const resp = '**4. q**\nA) a\nB) b\nSpiegazione: La risposta corretta e B perche cosi.';
    assert.strictEqual(parseAnswers(resp).answers['4'].letter, 'B');
});

test('parseAnswers: explicit [CORRETTA] marker wins over prose', () => {
    const resp = '**4. q**\nA) a\nB) b [CORRETTA]\nSpiegazione: La risposta corretta è A.';
    assert.strictEqual(parseAnswers(resp).answers['4'].letter, 'B');
});

// --- ordering regression ----------------------------------------------------
// Parsed answers must be keyed by their real question number so the summary
// table and analysis can be assembled in numeric order regardless of tier.

test('parseAnswers keys answers by question number across a multi-block reply', () => {
    const resp = [
        '**1. uno**\nA) a [CORRETTA]\nSpiegazione: [AI] x',
        '**2. due**\nB) b [CORRETTA]\nSpiegazione: [AI] x',
        '**3. tre**\nC) c [CORRETTA]\nSpiegazione: [AI] x'
    ].join('\n\n---\n\n');
    const { answers } = parseAnswers(resp);
    assert.deepStrictEqual(
        Object.keys(answers).sort(),
        ['1', '2', '3']
    );
    assert.strictEqual(answers['1'].letter, 'A');
    assert.strictEqual(answers['2'].letter, 'B');
    assert.strictEqual(answers['3'].letter, 'C');
});

// --- parseAnswers() : tolerance to real model formatting --------------------
// Every variant below used to leave a "?", and each surviving "?" costs a
// whole extra Opus recovery call.

test('parseAnswers reads the marker even with trailing text or bold', () => {
    const trailing = '**1. q**\nA) a\nB) b [CORRETTA] - perché è la definizione\nSpiegazione: [AI] x';
    const bold = '**2. q**\nA) a\n**B) b [CORRETTA]**\nSpiegazione: [AI] x';
    assert.strictEqual(parseAnswers(trailing).answers['1'].letter, 'B');
    assert.strictEqual(parseAnswers(bold).answers['2'].letter, 'B');
});

test('parseAnswers supports option E and "A." separators', () => {
    const optionE = '**3. q**\nA) a\nB) b\nC) c\nD) d\nE) e [CORRETTA]\nSpiegazione: [AI] x';
    const dotted = '**4. q**\nA. a\nB. b [CORRETTA]\nSpiegazione: [AI] x';
    assert.strictEqual(parseAnswers(optionE).answers['3'].letter, 'E');
    assert.strictEqual(parseAnswers(dotted).answers['4'].letter, 'B');
});

test('parseAnswers prose fallback handles "Risposta corretta: B" without space', () => {
    const resp = '**5. q**\nA) a\nB) b\nRisposta corretta: B\nSpiegazione: [AI] x';
    assert.strictEqual(parseAnswers(resp).answers['5'].letter, 'B');
});

test('parseAnswers still leaves "?" when nothing marks an answer', () => {
    const resp = '**6. q**\nA) a\nB) b\nSpiegazione: [AI] non determinabile';
    assert.strictEqual(parseAnswers(resp).answers['6'].letter, '?');
});

// --- parseAnswers() : citation verification ---------------------------------
// Without the context, "[CITATO]" is only the model's word about itself.

const CONTEXT = '[M1 | Sez. 3.6] Il decoupling consiste nel disaccoppiare la crescita economica dall uso delle risorse naturali, come mostra il rapporto OCSE del 2011.';

test('a quotation found in the material stays CITATO', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] "disaccoppiare la crescita economica dall uso delle risorse naturali" [Sez. 3.6].';
    assert.strictEqual(parseAnswers(resp, CONTEXT).answers['1'].source, 'CITATO');
});

test('an invented quotation is demoted to NON_VERIFICATA', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] "il decoupling fu abolito dal trattato di Lisbona del 2007" [Sez. 3.6].';
    assert.strictEqual(parseAnswers(resp, CONTEXT).answers['1'].source, 'NON_VERIFICATA');
});

test('an elided quotation is verified fragment by fragment', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] "Il decoupling consiste nel disaccoppiare la crescita [...] come mostra il rapporto OCSE del 2011" [Sez. 3.6].';
    assert.strictEqual(parseAnswers(resp, CONTEXT).answers['1'].source, 'CITATO');
});

test('a CITATO tag with no quotation at all cannot be verified', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] il materiale lo conferma [Sez. 3.6].';
    assert.strictEqual(parseAnswers(resp, CONTEXT).answers['1'].source, 'NON_VERIFICATA');
});

test('without context the verification is skipped (back-compatible)', () => {
    const resp = '**1. q**\nA) a [CORRETTA]\nSpiegazione: [CITATO] "qualunque cosa" [Sez. 3.6].';
    assert.strictEqual(parseAnswers(resp).answers['1'].source, 'CITATO');
});
