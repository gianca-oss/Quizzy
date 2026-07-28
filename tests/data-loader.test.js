const { test } = require('node:test');
const assert = require('node:assert');
const { isTableOfContents } = require('../api/data-loader');

// --- isTableOfContents() : corpus noise filter ------------------------------
// Table-of-contents chunks are keyword-dense but content-free: they used to
// win 10.7% of all retrieval slots, displacing material that can actually
// answer a question. The corpus separates cleanly (281/308 chunks have zero
// dotted lines, TOC ones sit at 0.89-1.00), so the 0.5 threshold has margin.

test('detects a table-of-contents chunk', () => {
    const toc = {
        text: [
            '[2. Istituzioni e imprese nella sfida per la sostenibilità19]',
            '2.1Il Global Compact delle Nazioni Unite  .  .  .  .  .  .  .  .  .19',
            '2.2L’Agenda 2030, gli SDG e i progressi delle aziende  .  .  .  .  .22',
            '2.3Le imprese purpose driven  .  .  .  .  .  .  .  .  .  .  .  .  .25'
        ].join('\n')
    };
    assert.strictEqual(isTableOfContents(toc), true);
});

test('keeps real content that happens to contain one dotted line', () => {
    const content = {
        text: [
            'Il Global Compact delle Nazioni Unite nasce nel 2000 come iniziativa',
            'volontaria rivolta alle imprese. I dieci principi coprono diritti umani,',
            'lavoro, ambiente e lotta alla corruzione . . . come richiamato sopra.',
            'Le aziende aderenti pubblicano una comunicazione annuale sui progressi.',
            'Questo meccanismo di rendicontazione è il cuore del programma.'
        ].join('\n')
    };
    assert.strictEqual(isTableOfContents(content), false);
});

test('does not flag short or empty chunks', () => {
    assert.strictEqual(isTableOfContents({ text: 'una riga sola' }), false);
    assert.strictEqual(isTableOfContents({ text: '' }), false);
    assert.strictEqual(isTableOfContents(null), false);
});
