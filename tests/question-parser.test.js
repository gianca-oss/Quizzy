const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuestionsWithStats, extractPrintedNumber } = require('../api/question-parser');

const wrap = (questions) => JSON.stringify({ questions });

// --- printed numbering ------------------------------------------------------
// The number printed on the sheet is the only thing that ties a row of the
// results table back to the paper in the user's hands. Positional numbering
// silently shifts as soon as a question is dropped or pages are photographed
// out of order.

test('keeps the question number printed on the quiz', () => {
    const { questions } = parseQuestionsWithStats(wrap([
        { text: '5. Prima domanda', options: { A: 'a', B: 'b' } },
        { text: '6. Seconda domanda', options: { A: 'a', B: 'b' } }
    ]));
    assert.deepStrictEqual(questions.map(q => q.printedNumber), [5, 6]);
});

test('printedNumber is null when the quiz does not number its questions', () => {
    const { questions } = parseQuestionsWithStats(wrap([
        { text: 'Domanda senza numero', options: { A: 'a', B: 'b' } }
    ]));
    assert.strictEqual(questions[0].printedNumber, null);
});

test('extractPrintedNumber ignores decimals and years', () => {
    assert.strictEqual(extractPrintedNumber('3.5 milioni di lavoratori'), null);
    assert.strictEqual(extractPrintedNumber('12) Il lavoro agile'), 12);
});

// --- dropped questions are reported -----------------------------------------
// They used to disappear without a trace: fewer rows in the table and no way
// for the user to know something was missing.

test('reports questions dropped because their options were unreadable', () => {
    const { questions, dropped } = parseQuestionsWithStats(wrap([
        { text: 'Leggibile', options: { A: 'a', B: 'b' } },
        { text: 'Rovinata', options: { A: '[illeggibile]', B: '[illeggibile]', C: 'c' } },
        { text: 'Anche questa ok', options: { A: 'a', B: 'b' } }
    ]));
    assert.strictEqual(questions.length, 2);
    assert.strictEqual(dropped, 1, 'the unreadable question must be counted, not silently lost');
});

test('flags a question that survived with only some options unreadable', () => {
    const { questions, illegible } = parseQuestionsWithStats(wrap([
        { text: 'Parziale', options: { A: 'a', B: 'b', C: '[illeggibile]' } }
    ]));
    assert.strictEqual(illegible, 1);
    assert.strictEqual(questions[0].partial, true);
});

test('counts questions truncated by the 30-question cap', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
        text: `Domanda ${i + 1}`, options: { A: 'a', B: 'b' }
    }));
    const { questions, truncated } = parseQuestionsWithStats(wrap(many));
    assert.strictEqual(questions.length, 30);
    assert.strictEqual(truncated, 3);
});
