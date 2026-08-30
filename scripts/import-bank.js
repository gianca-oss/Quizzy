#!/usr/bin/env node
/**
 * Build a course question-bank from an exam-materials PDF.
 *
 * The source layout (dispensa integrata EMBA) repeats once per course:
 *
 *   <cap>.2  Parte I - Le quindici domande più probabili
 *   <cap>.2.1.1  Domanda 1. <testo, può proseguire sulle righe seguenti>
 *   •A)<testo opzione, può proseguire>
 *   •B)...
 *   ...
 *   <cap>.5  Soluzioni commentate
 *   DomandeRisposte corrette
 *   1-10C D B A C B D A C B          <- griglia rapida
 *   <cap>.5.1.1  Risposta corretta: C - <blocco tematico>
 *   <spiegazione, una o più righe>
 *
 * Questions and solutions are in the same order and both restart from 1 in
 * every course, so they are joined by position. The correction grid is parsed
 * as an INDEPENDENT third source: an entry is accepted only when the letter in
 * the commented solution and the letter in the grid agree. A disagreement means
 * one of the two is wrong and we cannot know which — the question is dropped
 * and listed in the report rather than guessed.
 *
 * Usage: node scripts/import-bank.js <file.pdf> <courseName> [--dry]
 */
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const [, , pdfPath, courseName, ...flags] = process.argv;
const DRY = flags.includes('--dry');

if (!pdfPath || !courseName) {
    console.error('Uso: node scripts/import-bank.js <file.pdf> <courseName> [--dry]');
    process.exit(1);
}

// --- riconoscimento delle righe ---------------------------------------------

// Piè di pagina: "Frey - materiali d'esame93". Interrompe le frasi a metà,
// quindi va tolto prima di ricomporre il testo che va a capo.
const PAGE_FOOTER = /^\s*[A-Za-zÀ-ÿ'’]+\s*[-–]\s*materiali\s+d[’']esame\s*\d+\s*$/i;
// Righe dell'indice: "9.5  Soluzioni commentate . . . . 111". Hanno gli stessi
// titoli delle sezioni vere e falserebbero la segmentazione per corso.
const TOC_LINE = /\.\s*\.\s*\.\s*\./;
// Titoli di sezione: chiudono la domanda in corso.
const SECTION = /^\s*(?:\d+(?:\.\d+)*)?\s*(Foglio\s+\d+|Parte\s+(?:I{1,3}|IV)\b|Soluzioni\s+commentate|Test\s+di\s+autoverifica|Materiali\s+per|Tabella\s+\d+)/i;
const BARE_NUMBER = /^\s*\d+(?:\.\d+)*\s*$/;
const BOILERPLATE = /^\s*Per ogni domanda (è|e) prevista una sola risposta corretta\.\s*$/i;

const Q_START = /^\s*(?:\d+(?:\.\d+)*\s*)?Domanda\s+(\d+)\.\s*(.*)$/;
const OPT_START = /^\s*[•·]\s*([A-D])\)\s*(.*)$/;
// Nella Parte I l'intestazione porta anche il blocco tematico
// ("Risposta corretta: C - Economia circolare"); dalla Parte II in poi c'e'
// solo la lettera. Il topic e' quindi opzionale.
const SOL_START = /^\s*(?:\d+(?:\.\d+)*\s*)?Risposta\s+corretta:\s*([A-D])\s*(?:[-–]\s*(.*))?$/i;
const GRID_ROW = /^\s*(\d+)\s*[-–]\s*(\d+)\s*([A-D](?:\s+[A-D])*)\s*$/;
// Fine del capitolo delle soluzioni: divisore di parte del volume o titolo di
// capitolo. Senza questo limite l'ultima spiegazione di ogni corso inghiotte
// tutti i capitoli successivi (misurato: 443.000 caratteri).
const REGION_END = /^\s*(?:CAPITOLO\s*\d+|Parte\s+(?:I{1,3}|IV))\s*$/i;

// Ancore di segmentazione per corso.
const COURSE_QSTART = /^\s*(\d+)\.2\s+Parte\s+I\b/;
const COURSE_SSTART = /^\s*(\d+)\.5\s+Soluzioni\s+commentate/i;

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Unisce due frammenti andati a capo. Il PDF non spezza le parole con il
// trattino, quindi basta uno spazio; senza, "recupero energetico" diventerebbe
// "recuperoenergetico".
const joinFragment = (a, b) => (a ? `${a} ${b}` : b);

// --- parsing ----------------------------------------------------------------

function parseQuestions(lines) {
    const out = [];
    let cur = null;
    let optLetter = null;

    const flush = () => {
        if (cur) {
            cur.text = squash(cur.text);
            Object.keys(cur.options).forEach(k => { cur.options[k] = squash(cur.options[k]); });
            out.push(cur);
        }
        cur = null;
        optLetter = null;
    };

    for (const line of lines) {
        if (BARE_NUMBER.test(line) || BOILERPLATE.test(line)) continue;

        const q = line.match(Q_START);
        if (q) {
            flush();
            cur = { num: parseInt(q[1], 10), text: q[2] || '', options: {} };
            continue;
        }
        if (!cur) continue;

        if (SECTION.test(line)) { flush(); continue; }

        const o = line.match(OPT_START);
        if (o) {
            optLetter = o[1];
            cur.options[optLetter] = o[2] || '';
            continue;
        }
        if (optLetter) cur.options[optLetter] = joinFragment(cur.options[optLetter], line.trim());
        else cur.text = joinFragment(cur.text, line.trim());
    }
    flush();
    return out;
}

function parseSolutions(lines) {
    const out = [];
    const grid = [];
    let cur = null;

    const flush = () => {
        if (cur) {
            cur.explanation = squash(cur.explanation);
            out.push(cur);
        }
        cur = null;
    };

    for (const line of lines) {
        const g = line.match(GRID_ROW);
        if (g && !cur) {
            const from = parseInt(g[1], 10);
            const letters = g[3].match(/[A-D]/g) || [];
            letters.forEach((L, i) => { grid[from + i] = L; });
            continue;
        }

        const s = line.match(SOL_START);
        if (s) {
            flush();
            cur = { letter: s[1].toUpperCase(), topic: squash(s[2] || ''), explanation: '' };
            continue;
        }
        if (!cur) continue;
        if (REGION_END.test(line)) { flush(); break; }
        if (SECTION.test(line)) { flush(); continue; }
        if (BARE_NUMBER.test(line)) continue;
        cur.explanation = joinFragment(cur.explanation, line.trim());
    }
    flush();
    return { solutions: out, grid };
}

// --- segmentazione per corso ------------------------------------------------

function segment(lines) {
    const qStarts = [];
    const sStarts = [];
    lines.forEach((l, i) => {
        if (COURSE_QSTART.test(l)) qStarts.push(i);
        if (COURSE_SSTART.test(l)) sStarts.push(i);
    });
    if (qStarts.length !== sStarts.length) {
        console.warn(`[import-bank] ATTENZIONE: ${qStarts.length} sezioni domande e ${sStarts.length} sezioni soluzioni`);
    }
    const blocks = [];
    for (let i = 0; i < Math.min(qStarts.length, sStarts.length); i++) {
        const qFrom = qStarts[i];
        const qTo = sStarts[i];
        const sFrom = sStarts[i];
        const sTo = i + 1 < qStarts.length ? qStarts[i + 1] : lines.length;
        blocks.push({ qFrom, qTo, sFrom, sTo });
    }
    return blocks;
}

// --- main -------------------------------------------------------------------

(async () => {
    const buf = fs.readFileSync(pdfPath);
    const data = await pdf(buf);
    const all = data.text.split('\n')
        .filter(l => l.trim() !== '' && !PAGE_FOOTER.test(l) && !TOC_LINE.test(l));

    console.log(`[import-bank] ${path.basename(pdfPath)} — ${data.numpages} pagine, ${all.length} righe utili\n`);

    const blocks = segment(all);
    console.log(`[import-bank] sezioni di test individuate: ${blocks.length}\n`);

    const bankQuestions = [];
    const report = [];

    blocks.forEach((b, bi) => {
        const questions = parseQuestions(all.slice(b.qFrom, b.qTo));
        const { solutions, grid } = parseSolutions(all.slice(b.sFrom, b.sTo));

        const stats = { corso: bi + 1, domande: questions.length, soluzioni: solutions.length, griglia: grid.filter(Boolean).length, importate: 0, scartate: [] };

        questions.forEach((q, i) => {
            const sol = solutions[i];
            const gridLetter = grid[q.num];
            const drop = (why) => stats.scartate.push(`Domanda ${q.num}: ${why}`);

            const letters = Object.keys(q.options).sort();
            if (letters.join('') !== 'ABCD') return drop(`opzioni incomplete (${letters.join('') || 'nessuna'})`);
            if (letters.some(L => !q.options[L])) return drop('una opzione è vuota');
            if (!q.text) return drop('testo mancante');
            if (!sol) return drop('nessuna soluzione in posizione corrispondente');
            if (!gridLetter) return drop('assente dalla griglia di correzione');
            if (sol.letter !== gridLetter) {
                return drop(`soluzione commentata dice ${sol.letter}, griglia dice ${gridLetter}`);
            }

            bankQuestions.push({
                question: q.text,
                options: q.options,
                correct: sol.letter,
                explanation: sol.explanation,
                topic: sol.topic,
                sourceSection: bi + 1,
                sourceNum: q.num
            });
            stats.importate++;
        });

        report.push(stats);
    });

    report.forEach(r => {
        console.log(`  sezione ${r.corso}: ${r.domande} domande · ${r.soluzioni} soluzioni · ${r.griglia} in griglia → ${r.importate} importate`);
        r.scartate.forEach(s => console.log(`      scartata — ${s}`));
    });

    const bank = {
        version: '1.0',
        course: courseName,
        count: bankQuestions.length,
        importedFrom: path.basename(pdfPath),
        questions: bankQuestions
    };

    console.log(`\n[import-bank] totale importate: ${bankQuestions.length}`);

    const outPath = path.join(__dirname, '..', 'data', 'processed', courseName, 'question-bank.json');
    if (DRY) {
        console.log(`[import-bank] --dry: nessun file scritto (destinazione sarebbe ${outPath})`);
        console.log('\n--- esempio, prima voce ---');
        console.log(JSON.stringify(bankQuestions[0], null, 2));
        return;
    }
    fs.writeFileSync(outPath, JSON.stringify(bank, null, 2) + '\n', 'utf-8');
    console.log(`[import-bank] scritto ${outPath}`);
})().catch(e => { console.error('[import-bank] errore:', e.message); process.exit(1); });
