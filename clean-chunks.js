// clean-chunks.js - Pulisce i chunks esistenti da errori OCR e marker
// Esegui: node clean-chunks.js

const fs = require('fs').promises;
const path = require('path');

const INPUT_DIR = './data/processed/strategia-internazionalizzazione';
const OUTPUT_DIR = './data/processed/strategia-internazionalizzazione'; // Sovrascrive

// ============================================
// STEP 1: CORREZIONE ERRORI OCR
// ============================================

/**
 * Pattern comuni di errori OCR nel testo italiano
 * Formato: [regex, sostituzione]
 */
const OCR_FIXES = [
    // Spazi inseriti erroneamente nelle parole - pattern base
    [/\ba\s+l\b/gi, 'al'],
    [/\bd\s+i\b/gi, 'di'],
    [/\bc\s+h\s+e\b/gi, 'che'],
    [/\bn\s+o\s+n\b/gi, 'non'],
    [/\bp\s+e\s+r\b/gi, 'per'],
    [/\bc\s+o\s+n\b/gi, 'con'],
    [/\bs\s+u\b/gi, 'su'],
    [/\bd\s+a\b/gi, 'da'],

    // Pattern specifici trovati nei chunks
    [/informa\s*zione/gi, 'informazione'],
    [/ela\s*bora/gi, 'elabora'],
    [/la\s*vora/gi, 'lavora'],
    [/ma\s*nua/gi, 'manua'],
    [/a\s*cqua/gi, 'acqua'],
    [/ra\s*giona/gi, 'ragiona'],
    [/qua\s*ndo/gi, 'quando'],
    [/qua\s*le/gi, 'quale'],
    [/qua\s*li/gi, 'quali'],
    [/a\s*ltri/gi, 'altri'],
    [/a\s*ltre/gi, 'altre'],
    [/a\s*ltro/gi, 'altro'],
    [/a\s*ltra/gi, 'altra'],
    [/sa\s*pere/gi, 'sapere'],
    [/sa\s*ppia/gi, 'sappia'],
    [/sa\s*remmo/gi, 'saremmo'],
    [/ca\s*pire/gi, 'capire'],
    [/ca\s*pita/gi, 'capita'],
    [/ca\s*pacità/gi, 'capacità'],
    [/a\s*zienda/gi, 'azienda'],
    [/a\s*ziende/gi, 'aziende'],
    [/orga\s*nizza/gi, 'organizza'],
    [/a\s*nalizza/gi, 'analizza'],
    [/a\s*nalisi/gi, 'analisi'],
    [/tra\s*sforma/gi, 'trasforma'],
    [/tra\s*smissibile/gi, 'trasmissibile'],
    [/tra\s*sferire/gi, 'trasferire'],
    [/tra\s*duzione/gi, 'traduzione'],
    [/tra\s*durre/gi, 'tradurre'],
    [/ma\s*ggiore/gi, 'maggiore'],
    [/ma\s*ggio/gi, 'maggio'],
    [/fa\s*cilmente/gi, 'facilmente'],
    [/a\s*ttività/gi, 'attività'],
    [/a\s*ttivi/gi, 'attivi'],
    [/a\s*ttivo/gi, 'attivo'],
    [/stra\s*tegia/gi, 'strategia'],
    [/stra\s*tegico/gi, 'strategico'],
    [/innova\s*zione/gi, 'innovazione'],
    [/innova\s*tivo/gi, 'innovativo'],
    [/tecnolo\s*gia/gi, 'tecnologia'],
    [/tecnolo\s*gico/gi, 'tecnologico'],
    [/a\s*pplica/gi, 'applica'],
    [/a\s*pprendi/gi, 'apprendi'],
    [/a\s*pprendimento/gi, 'apprendimento'],
    [/proba\s*bile/gi, 'probabile'],
    [/proba\s*bilmente/gi, 'probabilmente'],
    [/persona\s*le/gi, 'personale'],
    [/genera\s*le/gi, 'generale'],
    [/genera\s*zione/gi, 'generazione'],
    [/opera\s*tivo/gi, 'operativo'],
    [/opera\s*zione/gi, 'operazione'],
    [/specifi\s*co/gi, 'specifico'],
    [/specifi\s*ca/gi, 'specifica'],
    [/crea\s*tivo/gi, 'creativo'],
    [/crea\s*zione/gi, 'creazione'],
    [/forma\s*le/gi, 'formale'],
    [/forma\s*zione/gi, 'formazione'],
    [/formalizza\s*ta/gi, 'formalizzata'],
    [/sistema\s*tico/gi, 'sistematico'],
    [/sistema\s*tica/gi, 'sistematica'],
    [/conoscen\s*za/gi, 'conoscenza'],
    [/conoscen\s*ze/gi, 'conoscenze'],
    [/esplicita\s*re/gi, 'esplicitare'],
    [/implici\s*ta/gi, 'implicita'],
    [/contesto\s*uale/gi, 'contestuale'],
    [/significa\s*to/gi, 'significato'],
    [/significa\s*tivo/gi, 'significativo'],
    [/fonda\s*mentale/gi, 'fondamentale'],
    [/fonda\s*mento/gi, 'fondamento'],
    [/sempli\s*ce/gi, 'semplice'],
    [/sempli\s*cemente/gi, 'semplicemente'],
    [/comple\s*sso/gi, 'complesso'],
    [/comple\s*ssità/gi, 'complessità'],
    [/integra\s*ta/gi, 'integrata'],
    [/integra\s*zione/gi, 'integrazione'],
    [/collega\s*ta/gi, 'collegata'],
    [/collega\s*mento/gi, 'collegamento'],
    [/accumula\s*ta/gi, 'accumulata'],
    [/accumula\s*to/gi, 'accumulato'],
    [/elabora\s*ta/gi, 'elaborata'],
    [/elabora\s*zione/gi, 'elaborazione'],
    [/interpreta\s*zione/gi, 'interpretazione'],
    [/interpreta\s*re/gi, 'interpretare'],
    [/comunica\s*zione/gi, 'comunicazione'],
    [/comunica\s*re/gi, 'comunicare'],
    [/valuta\s*re/gi, 'valutare'],
    [/valuta\s*zione/gi, 'valutazione'],
    [/importa\s*nte/gi, 'importante'],
    [/importa\s*nza/gi, 'importanza'],
    [/conseguen\s*za/gi, 'conseguenza'],
    [/conseguen\s*ze/gi, 'conseguenze'],
    [/esperien\s*za/gi, 'esperienza'],
    [/esperien\s*ze/gi, 'esperienze'],
    [/differen\s*za/gi, 'differenza'],
    [/differen\s*ze/gi, 'differenze'],

    // Nuovi pattern specifici trovati
    [/gera\s*rchico/gi, 'gerarchico'],
    [/da\s*tigrezzi/gi, 'dati grezzi'],
    [/sitra\s*sformino/gi, 'si trasformino'],
    [/dellapira\s*mide/gi, 'della piramide'],
    [/significa\s*toed/gi, 'significato ed'],
    [/ha\s*nno/gi, 'hanno'],
    [/a\s*cquisiscono/gi, 'acquisiscono'],
    [/doma\s*nda/gi, 'domanda'],
    [/tempera\s*tura/gi, 'temperatura'],
    [/alladoma\s*nda/gi, 'alla domanda'],
    [/sullavita/gi, 'sulla vita'],
    [/tuttoqua\s*nto/gi, 'tutto quanto'],
    [/ca\s*ratteristica/gi, 'caratteristica'],
    [/essenzia\s*le/gi, 'essenziale'],
    [/lirende/gi, 'li rende'],
    [/L'informazionenasce/gi, "L'informazione nasce"],
    [/estruttura/gi, 'e struttura'],
    [/informazioneperché/gi, 'informazione perché'],
    [/crucia\s*le/gi, 'cruciale'],
    [/sta\s*to/gi, 'stato'],
    [/Romaci/gi, 'Roma ci'],
    [/a\s*noma\s*lo/gi, 'anomalo'],
    [/l'informazioneviene/gi, "l'informazione viene"],
    [/resaopera\s*tiva/gi, 'resa operativa'],
    [/l'acquabolle/gi, "l'acqua bolle"],
    [/incorpora\s*tanell/gi, 'incorporata nell'],
    [/a\s*rticola\s*re/gi, 'articolare'],
    [/aspiega\s*reesa\s*ttamente/gi, 'a spiegare esattamente'],
    [/ma\s*ntenere/gi, 'mantenere'],
    [/allapura/gi, 'alla pura'],
    [/elaborazionedell/gi, 'elaborazione dell'],
    [/sisa/gi, 'si sa'],
    [/intenziona\s*li/gi, 'intenzionali'],
    [/bilancia\s*revalori/gi, 'bilanciare valori'],
    [/naviga\s*re/gi, 'navigare'],
    [/appa\s*rtenga/gi, 'appartenga'],
    [/da\s*vvero/gi, 'davvero'],
    [/ca\s*tegoria/gi, 'categoria'],
    [/altritre/gi, 'altri tre'],
    [/mora\s*le/gi, 'morale'],
    [/risa\s*le/gi, 'risale'],
    [/a\s*ntichi/gi, 'antichi'],
    [/siproduce/gi, 'si produce'],
    [/a\s*mbienta\s*liba\s*sandosi/gi, 'ambientali basandosi'],
    [/cambia\s*mentoclimatico/gi, 'cambiamento climatico'],
    [/consiglia\s*re/gi, 'consigliare'],
    [/altriba\s*sandosi/gi, 'altri basandosi'],
    [/equilibra\s*to/gi, 'equilibrato'],
    [/applica\s*zioneetica/gi, 'applicazione etica'],
    [/contestua\s*lizzazione/gi, 'contestualizzazione'],
    [/valoria\s*le/gi, 'valoriale'],
    [/a\s*mbito/gi, 'ambito'],
    [/nellatesta/gi, 'nella testa'],
    [/interpretia\s*mo/gi, 'interpretiamo'],
    [/influenza\s*nociò/gi, 'influenzano ciò'],
    [/ela\s*birra/gi, 'e la birra'],
    [/a\s*cquisto/gi, 'acquisto'],
    [/aggrega\s*ndo/gi, 'aggregando'],
    [/sivuol/gi, 'si vuol'],
    [/scaffa\s*li/gi, 'scaffali'],
    [/birragra\s*tis/gi, 'birra gratis'],
    [/giratutto/gi, 'gira tutto'],
    [/supermerca\s*to/gi, 'supermercato'],
    [/ma\s*ga\s*ri/gi, 'magari'],
    [/a\s*cquista/gi, 'acquista'],
    [/Averetanti/gi, 'Avere tanti'],
    [/a\s*veretante/gi, 'avere tante'],
    [/da\s*tied/gi, 'dati ed'],
    [/saperli/gi, 'saperli'],
    [/edelaborarli/gi, 'ed elaborarli'],
    [/correla\s*ti/gi, 'correlati'],
    [/sa\s*per/gi, 'saper'],
    [/interpreta\s*rli/gi, 'interpretarli'],
    [/a\s*veredelle/gi, 'avere delle'],
    [/sosta\s*nza/gi, 'sostanza'],
    [/a\s*lcuni/gi, 'alcuni'],

    // Pattern con 'da ' seguito da parole
    [/da\s+ti\b/gi, 'dati'],
    [/da\s+lla\b/gi, 'dalla'],
    [/da\s+lle\b/gi, 'dalle'],
    [/da\s+llo\b/gi, 'dallo'],
    [/da\s+l\b/gi, 'dal'],

    // Pattern con 'i' o 'e' come articolo incollato
    [/\bida\s*ti\b/gi, 'i dati'],
    [/\bipunti\b/gi, 'i punti'],
    [/\bono\b/gi, 'o no'],
    [/\bevvero\b/gi, 'e vero'],
    [/\bequindi\b/gi, 'e quindi'],
    [/\beciò\b/gi, 'e ciò'],
    [/\bgiàun\b/gi, 'già un'],
    [/\bosbagliati\b/gi, 'o sbagliati'],
    [/\baquesti\b/gi, 'a questi'],
    [/\bvabene\b/gi, 'va bene'],

    // Parole spezzate comuni
    [/rappresenta\s*ti/gi, 'rappresentati'],
    [/devia\s*nza/gi, 'devianza'],
    [/regola\s*rità/gi, 'regolarità'],
    [/correla\s*ta/gi, 'correlata'],

    // Spazi prima di punteggiatura
    [/\s+\./g, '.'],
    [/\s+,/g, ','],
    [/\s+:/g, ':'],
    [/\s+;/g, ';'],
    [/\s+\?/g, '?'],
    [/\s+!/g, '!'],

    // Doppi spazi
    [/\s{2,}/g, ' '],

    // Newline multipli
    [/\n{3,}/g, '\n\n'],
];

/**
 * Applica correzioni OCR al testo
 */
function fixOCRErrors(text) {
    let fixed = text;

    for (const [pattern, replacement] of OCR_FIXES) {
        fixed = fixed.replace(pattern, replacement);
    }

    return fixed;
}

// ============================================
// STEP 2: RIMOZIONE MARKER STRUTTURALI
// ============================================

/**
 * Rimuove marker come [HEADER], [FIG], [TAB], ecc.
 * Mantiene il contenuto dopo i marker di heading
 */
function removeStructuralMarkers(text) {
    return text
        // Rimuovi marker completamente
        .replace(/\[TABELLA\]/gi, '')
        .replace(/\[TAB\][^\n]*/gi, '')  // Rimuovi intera riga tabella
        .replace(/\[FIG\][^\n]*/gi, '')  // Rimuovi intera riga figura

        // Converti heading marker in testo normale
        .replace(/\[HEADER\]\s*/gi, '')
        .replace(/\[H1\]\s*/gi, '')
        .replace(/\[H2\]\s*/gi, '## ')
        .replace(/\[H3\]\s*/gi, '### ')
        .replace(/\[H4\]\s*/gi, '#### ')

        // Rimuovi [Pagina X] marker
        .replace(/\[Pagina\s*\d+\]/gi, '')

        // Pulisci spazi risultanti
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+/gm, '')
        .trim();
}

// ============================================
// STEP 3: ESTRAZIONE KEYWORDS MIGLIORATE
// ============================================

/**
 * Termini tecnici specifici del corso
 */
const TECHNICAL_TERMS = new Set([
    // Knowledge Management
    'knowledge', 'management', 'conoscenza', 'conoscenze', 'tacita', 'esplicita',
    'implicita', 'dikw', 'saggezza', 'informazione', 'informazioni', 'dati',

    // Business & Strategy
    'strategia', 'strategico', 'business', 'model', 'canvas', 'value', 'proposition',
    'competitive', 'vantaggio', 'competitivo', 'mercato', 'cliente', 'clienti',
    'segmento', 'segmenti', 'revenue', 'ricavi', 'costi', 'risorse', 'attività',
    'partner', 'canali', 'relazioni',

    // Innovation
    'innovazione', 'innovativo', 'disruptive', 'disruption', 'sustaining',
    'incumbent', 'startup', 'scalabilità', 'piattaforma', 'ecosistema',

    // Organization
    'organizzazione', 'organizzazioni', 'azienda', 'aziende', 'impresa',
    'leadership', 'manager', 'dipendenti', 'team', 'cultura', 'processo',
    'processi', 'routine',

    // Technology
    'tecnologia', 'tecnologie', 'digitale', 'digitali', 'software', 'hardware',
    'algoritmo', 'automazione', 'intelligenza', 'artificiale',

    // Economics
    'economia', 'economico', 'economica', 'valore', 'prezzo', 'costo',
    'investimento', 'capitale', 'profitto', 'margine',

    // International
    'internazionalizzazione', 'globale', 'globali', 'export', 'import',
    'mercati', 'estero', 'multinazionale',

    // Specific concepts from the course
    'polanyi', 'nonaka', 'takeuchi', 'christensen', 'schumpeter', 'porter',
    'seci', 'socializzazione', 'esternalizzazione', 'combinazione', 'internalizzazione',
    'brevetto', 'brevetti', 'copyright', 'proprietà', 'intellettuale',
]);

/**
 * Stop words estese per italiano
 */
const STOP_WORDS = new Set([
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
    'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',
    'del', 'dello', 'della', 'dei', 'degli', 'delle',
    'al', 'allo', 'alla', 'ai', 'agli', 'alle',
    'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle',
    'nel', 'nello', 'nella', 'nei', 'negli', 'nelle',
    'sul', 'sullo', 'sulla', 'sui', 'sugli', 'sulle',
    'e', 'ed', 'o', 'od', 'ma', 'però', 'quindi', 'perché', 'perche',
    'che', 'chi', 'cui', 'quale', 'quali', 'quanto', 'quanta', 'quanti', 'quante',
    'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle',
    'come', 'dove', 'quando', 'se', 'anche', 'ancora', 'già', 'sempre', 'mai', 'molto',
    'più', 'meno', 'tanto', 'poco', 'tutto', 'tutti', 'ogni', 'altro', 'altri',
    'essere', 'è', 'sono', 'sia', 'stato', 'stata', 'stati', 'state', 'essere',
    'avere', 'ha', 'hanno', 'aveva', 'avevano', 'avrà', 'avranno',
    'fare', 'fa', 'fanno', 'fatto', 'fatta', 'fatti', 'fatte',
    'dire', 'dice', 'dicono', 'detto', 'detta',
    'potere', 'può', 'possono', 'potrebbe', 'potrebbero',
    'dovere', 'deve', 'devono', 'dovrebbe', 'dovrebbero',
    'volere', 'vuole', 'vogliono', 'vorrebbe', 'vorrebbero',
    'proprio', 'stessa', 'stesso', 'cosa', 'cose', 'modo', 'parte', 'caso',
    'punto', 'fatto', 'esempio', 'ovvero', 'cioè', 'infatti', 'inoltre',
    'abbiamo', 'hanno', 'quella', 'quello', 'nelle', 'dalla', 'come',
]);

/**
 * Estrae keywords tecniche dal testo
 */
function extractTechnicalKeywords(text, maxKeywords = 10) {
    // Normalizza testo
    const normalized = text.toLowerCase()
        .replace(/[^\w\sàèéìòùáéíóú]/g, ' ')
        .replace(/\s+/g, ' ');

    const words = normalized.split(' ');
    const wordFreq = {};

    // Conta frequenza delle parole
    for (const word of words) {
        if (word.length < 3) continue;
        if (STOP_WORDS.has(word)) continue;

        wordFreq[word] = (wordFreq[word] || 0) + 1;
    }

    // Ordina per: 1) termini tecnici, 2) frequenza
    const scored = Object.entries(wordFreq).map(([word, freq]) => ({
        word,
        freq,
        isTechnical: TECHNICAL_TERMS.has(word),
        score: (TECHNICAL_TERMS.has(word) ? 100 : 0) + freq
    }));

    scored.sort((a, b) => b.score - a.score);

    // Prendi top keywords
    return scored.slice(0, maxKeywords).map(item => item.word);
}

// ============================================
// MAIN PROCESSING
// ============================================

async function cleanAllChunks() {
    console.log('🧹 PULIZIA CHUNKS - Miglioramento qualità\n');
    console.log('='.repeat(50));

    // Carica tutti i chunks
    console.log('\n📖 Caricamento chunks esistenti...');
    const files = await fs.readdir(INPUT_DIR);
    const chunkFiles = files.filter(f => f.startsWith('chunks_') && f.endsWith('.json'));

    let allChunks = [];
    let totalOriginalChars = 0;

    for (const file of chunkFiles.sort()) {
        const content = await fs.readFile(path.join(INPUT_DIR, file), 'utf-8');
        const chunks = JSON.parse(content);
        allChunks = allChunks.concat(chunks);
        chunks.forEach(c => totalOriginalChars += c.text.length);
    }

    console.log(`✅ Caricati ${allChunks.length} chunks da ${chunkFiles.length} file`);
    console.log(`   Caratteri totali: ${totalOriginalChars.toLocaleString()}`);

    // Processa ogni chunk
    console.log('\n🔧 Applicazione miglioramenti...');
    let fixedOCRCount = 0;
    let removedMarkersCount = 0;
    let totalCleanedChars = 0;

    const cleanedChunks = allChunks.map((chunk, idx) => {
        const originalText = chunk.text;

        // Step 1: Fix OCR errors
        let cleanedText = fixOCRErrors(originalText);
        if (cleanedText !== originalText) fixedOCRCount++;

        // Step 2: Remove structural markers
        const afterMarkers = removeStructuralMarkers(cleanedText);
        if (afterMarkers.length < cleanedText.length) removedMarkersCount++;
        cleanedText = afterMarkers;

        // Step 3: Extract better keywords
        const newKeywords = extractTechnicalKeywords(cleanedText, 8);

        totalCleanedChars += cleanedText.length;

        if ((idx + 1) % 100 === 0) {
            console.log(`   Processati ${idx + 1}/${allChunks.length} chunks...`);
        }

        return {
            ...chunk,
            text: cleanedText,
            keywords: newKeywords
        };
    });

    console.log(`\n📊 Statistiche pulizia:`);
    console.log(`   OCR corretti: ${fixedOCRCount} chunks`);
    console.log(`   Marker rimossi: ${removedMarkersCount} chunks`);
    console.log(`   Caratteri prima: ${totalOriginalChars.toLocaleString()}`);
    console.log(`   Caratteri dopo: ${totalCleanedChars.toLocaleString()}`);
    console.log(`   Riduzione: ${((1 - totalCleanedChars/totalOriginalChars) * 100).toFixed(1)}%`);

    // Salva chunks puliti
    console.log('\n💾 Salvataggio chunks puliti...');
    const CHUNKS_PER_FILE = 50;
    const numFiles = Math.ceil(cleanedChunks.length / CHUNKS_PER_FILE);

    for (let i = 0; i < numFiles; i++) {
        const start = i * CHUNKS_PER_FILE;
        const end = Math.min(start + CHUNKS_PER_FILE, cleanedChunks.length);
        const fileChunks = cleanedChunks.slice(start, end);

        const filename = path.join(OUTPUT_DIR, `chunks_${i}.json`);
        await fs.writeFile(filename, JSON.stringify(fileChunks, null, 2));

        const stats = await fs.stat(filename);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`   ✅ chunks_${i}.json (${fileChunks.length} chunks, ${sizeMB} MB)`);
    }

    // Aggiorna metadata
    const metadataPath = path.join(OUTPUT_DIR, 'metadata.json');
    try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        metadata.version = '2.0-cleaned';
        metadata.cleanedAt = new Date().toISOString();
        metadata.stats.totalCharacters = totalCleanedChars;
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        console.log('   ✅ metadata.json aggiornato');
    } catch (e) {
        console.log('   ⚠️ Metadata non aggiornato:', e.message);
    }

    // Mostra esempio di chunk pulito
    console.log('\n📋 Esempio chunk pulito:');
    console.log('-'.repeat(50));
    const sampleChunk = cleanedChunks[5];
    console.log(`ID: ${sampleChunk.id}`);
    console.log(`Keywords: ${sampleChunk.keywords.join(', ')}`);
    console.log(`Testo (primi 500 char):\n${sampleChunk.text.substring(0, 500)}...`);

    console.log('\n' + '='.repeat(50));
    console.log('✅ PULIZIA COMPLETATA!');
    console.log('='.repeat(50));
    console.log('\n⚠️ Ora devi rigenerare gli embeddings:');
    console.log('   OPENAI_API_KEY="sk-..." node preprocess-embeddings.js');

    return cleanedChunks;
}

// Esegui
if (require.main === module) {
    cleanAllChunks().catch(console.error);
}

module.exports = { cleanAllChunks, fixOCRErrors, removeStructuralMarkers, extractTechnicalKeywords };
