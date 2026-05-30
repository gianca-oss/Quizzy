const { test } = require('node:test');
const assert = require('node:assert');
const {
    normalize,
    similarity,
    mechanicalRemap,
    lookupQuestions
} = require('../api/question-bank');

// --- normalize() : accent + apostrophe unification --------------------------
// Root cause of the "bank questions don't match" bug: the bank stores
// apostrophe-style accents ("puo'") while OCR produces real accents ("può").
// normalize() must collapse BOTH to the same bare token.

test('normalize strips combining-diacritic accents (può -> puo)', () => {
    assert.strictEqual(normalize('può'), 'puo');
    assert.strictEqual(normalize('perché'), 'perche');
    assert.strictEqual(normalize('responsabilità'), 'responsabilita');
});

test('normalize strips apostrophe-style accents (puo\' -> puo)', () => {
    assert.strictEqual(normalize("puo'"), 'puo');
    assert.strictEqual(normalize("perche'"), 'perche');
    assert.strictEqual(normalize("responsabilita'"), 'responsabilita');
});

test('normalize makes apostrophe and real-accent forms IDENTICAL', () => {
    assert.strictEqual(normalize("puo'"), normalize('può'));
    assert.strictEqual(normalize("perche'"), normalize('perché'));
    assert.strictEqual(normalize("responsabilita'"), normalize('responsabilità'));
});

test('normalize lowercases, collapses punctuation and whitespace', () => {
    assert.strictEqual(normalize('  La  SOMMINISTRAZIONE, può...  '), 'la somministrazione puo');
});

// --- similarity() -----------------------------------------------------------

test('similarity is 1 for identical strings', () => {
    assert.strictEqual(similarity('la somministrazione', 'la somministrazione'), 1);
});

test('similarity collapses accent/apostrophe variants to a perfect match', () => {
    const a = normalize('Il lavoro agile è consentito su accordo tra le parti');
    const b = normalize("Il lavoro agile e' consentito su accordo tra le parti");
    assert.strictEqual(similarity(a, b), 1);
});

test('similarity is low for unrelated sentences', () => {
    const a = normalize('La somministrazione di lavoro');
    const b = normalize('Earth Overshoot Day emissioni oceani');
    assert.ok(similarity(a, b) < 0.3, `expected low score, got ${similarity(a, b)}`);
});

// --- mechanicalRemap() : reordered options ----------------------------------
// The photo can present the same options in a different order than the bank.
// The correct LETTER must be remapped by matching option TEXT, not position.

test('mechanicalRemap follows the correct option text when order changes', () => {
    const bankMatch = {
        correct: 'A',
        options: {
            A: 'Solo dalle agenzie per il lavoro',
            B: 'Dalle agenzie per il lavoro e i comuni',
            C: 'Dai comuni e dalle università'
        }
    };
    // Photo lists the correct answer under C instead of A.
    const photoOptions = {
        A: 'Dai comuni e dalle università',
        B: 'Dalle agenzie per il lavoro e i comuni',
        C: 'Solo dalle agenzie per il lavoro'
    };
    assert.strictEqual(mechanicalRemap(bankMatch, photoOptions), 'C');
});

test('mechanicalRemap returns null when no option is similar enough', () => {
    const bankMatch = { correct: 'A', options: { A: 'Solo dalle agenzie per il lavoro' } };
    const photoOptions = { A: 'Una risposta completamente diversa e non correlata' };
    assert.strictEqual(mechanicalRemap(bankMatch, photoOptions), null);
});

// --- lookupQuestions() : end-to-end against the real bank --------------------

test('lookupQuestions routes a known bank question to bank tiers (not unmatched)', () => {
    const questions = [{
        text: 'La somministrazione può essere legittimamente effettuata:',
        options: {
            A: 'Solo dalle agenzie per il lavoro',
            B: 'Dalle agenzie per il lavoro e i comuni',
            C: 'Dai comuni e dalle università'
        }
    }];
    const { direct, needsHaiku, unmatched } = lookupQuestions(questions, 'organizzazione-e-lavoro');
    assert.strictEqual(unmatched.length, 0, 'known question must not fall through to RAG');
    assert.ok(direct.length + needsHaiku.length === 1);
});

test('lookupQuestions direct match remaps to the correct letter', () => {
    const questions = [{
        text: 'La somministrazione può essere legittimamente effettuata:',
        options: {
            A: 'Solo dalle agenzie per il lavoro',
            B: 'Dalle agenzie per il lavoro e i comuni',
            C: 'Dai comuni e dalle università'
        }
    }];
    const { direct } = lookupQuestions(questions, 'organizzazione-e-lavoro');
    assert.ok(direct.length === 1 && direct[0].remappedLetter === 'A');
});

test('lookupQuestions reports unmatched for a question not in the bank', () => {
    const questions = [{
        text: 'Qual è la capitale di un pianeta immaginario inventato per questo test?',
        options: { A: 'Alfa', B: 'Beta', C: 'Gamma' }
    }];
    const { unmatched } = lookupQuestions(questions, 'organizzazione-e-lavoro');
    assert.strictEqual(unmatched.length, 1);
});
