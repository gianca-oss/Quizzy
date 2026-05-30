const { test } = require('node:test');
const assert = require('node:assert');
const {
    stripLeadingNum,
    buildRagContext,
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
