#!/usr/bin/env node
/**
 * Normalize a course question-bank at build time.
 *
 * Why: at runtime lookupQuestions() calls normalize(bankQ.question) for EVERY
 * bank entry on EVERY incoming question — O(N×M) normalize() calls. Precomputing
 * a `normalized` field once collapses that to a field read. It also makes the
 * canonical (accent/apostrophe-stripped) form inspectable and lets us drop exact
 * duplicates that would otherwise waste comparisons and skew similarity ties.
 *
 * What it does, idempotently:
 *   1. Adds `normalized` (= normalize(question)) to every entry.
 *   2. Drops exact duplicates (same normalized question + options + correct).
 *   3. Refreshes `count` and stamps `normalizedAt`.
 *
 * Usage: node scripts/normalize-bank.js [courseName]
 *        (default course: organizzazione-e-lavoro)
 */
const fs = require('fs');
const path = require('path');
const { normalize } = require('../api/question-bank');

const courseName = process.argv[2] || 'organizzazione-e-lavoro';
const bankPath = path.join(__dirname, '..', 'data', 'processed', courseName, 'question-bank.json');

if (!fs.existsSync(bankPath)) {
    console.error(`[normalize-bank] Bank not found: ${bankPath}`);
    process.exit(1);
}

const bank = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));
const original = bank.questions.length;

// Canonical signature: normalized question + normalized option texts + correct.
// Two entries with the same signature are genuinely the same question.
function signature(q) {
    const opts = Object.keys(q.options || {})
        .sort()
        .map(k => `${k}:${normalize(q.options[k])}`)
        .join('|');
    return `${normalize(q.question)}#${opts}#${q.correct}`;
}

const seen = new Set();
const deduped = [];
let duplicates = 0;

for (const q of bank.questions) {
    const sig = signature(q);
    if (seen.has(sig)) {
        duplicates++;
        continue;
    }
    seen.add(sig);
    deduped.push({ ...q, normalized: normalize(q.question) });
}

bank.questions = deduped;
bank.count = deduped.length;
bank.normalizedAt = new Date().toISOString();

fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n', 'utf-8');

console.log(`[normalize-bank] ${courseName}`);
console.log(`  input questions:   ${original}`);
console.log(`  duplicates removed: ${duplicates}`);
console.log(`  output questions:  ${deduped.length}`);
console.log(`  precomputed 'normalized' field on every entry.`);
