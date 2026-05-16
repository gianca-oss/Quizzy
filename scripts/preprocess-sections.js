// preprocess-sections.js - Chunking basato sulla struttura del documento
// Uso: node scripts/preprocess-sections.js <nome-corso> [pdf-filename]

const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');

const COURSE_NAME = process.argv[2];
if (!COURSE_NAME) {
    console.error('Uso: node scripts/preprocess-sections.js <nome-corso> [pdf-filename]');
    process.exit(1);
}

const PDF_FILENAME = process.argv[3] || 'source.pdf';
const INPUT_PDF = path.join('./data/source', COURSE_NAME, PDF_FILENAME);
const OUTPUT_DIR = path.join('./data/processed', COURSE_NAME);

const MAX_CHUNK_SIZE = 4000;
const OVERLAP_SIZE = 200;

const SECTION_PATTERN = /^(\d+\.\d+)\s+(.+)/;
const CHAPTER_PATTERN = /^([1-7])\s{2,}([A-Z].*)/;
const GIORNATA_PATTERN = /^(PRIMA|SECONDA|TERZA|QUARTA|QUINTA|SESTA|SETTIMA)\s+GIORNATA/i;

function extractKeywords(text) {
    const stopWords = new Set([
        'il', 'la', 'di', 'che', 'e', 'a', 'un', 'in', 'con', 'per', 'da', 'su',
        'i', 'le', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'dal', 'dalla',
        'nel', 'nella', 'sul', 'sulla', 'è', 'sono', 'questo', 'questa',
        'come', 'anche', 'più', 'non', 'degli', 'uno', 'una', 'gli', 'alle',
        'tra', 'fra', 'loro', 'dove', 'quando', 'quella', 'quello', 'suoi'
    ]);

    const words = text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !stopWords.has(word));

    const freq = {};
    words.forEach(word => { freq[word] = (freq[word] || 0) + 1; });

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word]) => word);
}

function splitSections(text) {
    const lines = text.split('\n');
    const sections = [];
    let currentSection = null;
    let tocEndLine = 0;

    // Skip table of contents: find where body text starts
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.match(GIORNATA_PATTERN) && !trimmed.includes('.')) {
            // Found "PRIMA GIORNATA" without dots (not TOC entry)
            tocEndLine = i;
            break;
        }
    }

    for (let i = tocEndLine; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        const chapterMatch = trimmed.match(CHAPTER_PATTERN);
        const sectionMatch = trimmed.match(SECTION_PATTERN);
        const giornataMatch = trimmed.match(GIORNATA_PATTERN);

        if (chapterMatch || sectionMatch || giornataMatch) {
            if (currentSection && currentSection.text.trim().length > 50) {
                sections.push(currentSection);
            }

            let title, level;
            if (giornataMatch) {
                title = trimmed;
                level = 'giornata';
            } else if (chapterMatch) {
                title = `${chapterMatch[1]}. ${chapterMatch[2]}`;
                level = 'chapter';
            } else {
                title = `${sectionMatch[1]} ${sectionMatch[2]}`;
                level = 'section';
            }

            currentSection = {
                title: title.substring(0, 120),
                level,
                text: '',
                startLine: i
            };
        } else if (currentSection) {
            currentSection.text += trimmed + '\n';
        }
    }

    if (currentSection && currentSection.text.trim().length > 50) {
        sections.push(currentSection);
    }

    return sections;
}

function sectionsToChunks(sections) {
    const chunks = [];
    let chunkId = 0;

    for (const section of sections) {
        const text = section.text.trim();

        if (text.length <= MAX_CHUNK_SIZE) {
            chunks.push({
                id: `chunk_${chunkId++}`,
                text: `[${section.title}]\n${text}`,
                section: section.title,
                level: section.level,
                keywords: extractKeywords(text)
            });
        } else {
            // Split large sections at paragraph boundaries
            const paragraphs = text.split(/\n\s*\n/);
            let currentText = '';

            for (const para of paragraphs) {
                if (currentText.length + para.length > MAX_CHUNK_SIZE && currentText.length > 0) {
                    chunks.push({
                        id: `chunk_${chunkId++}`,
                        text: `[${section.title}]\n${currentText.trim()}`,
                        section: section.title,
                        level: section.level,
                        keywords: extractKeywords(currentText)
                    });

                    // Overlap: keep last bit of previous chunk
                    const overlapText = currentText.slice(-OVERLAP_SIZE);
                    currentText = overlapText + '\n' + para;
                } else {
                    currentText += (currentText ? '\n\n' : '') + para;
                }
            }

            if (currentText.trim().length > 50) {
                chunks.push({
                    id: `chunk_${chunkId++}`,
                    text: `[${section.title}]\n${currentText.trim()}`,
                    section: section.title,
                    level: section.level,
                    keywords: extractKeywords(currentText)
                });
            }
        }
    }

    return chunks;
}

async function main() {
    console.log(`\nPreprocessing basato su sezioni: ${COURSE_NAME}\n`);

    const pdfBuffer = await fs.readFile(INPUT_PDF);
    const pdfData = await pdfParse(pdfBuffer, { max: 0 });
    console.log(`PDF: ${pdfData.numpages} pagine, ${pdfData.text.length.toLocaleString()} caratteri`);

    const sections = splitSections(pdfData.text);
    console.log(`Sezioni trovate: ${sections.length}`);

    const sectionsByLevel = { giornata: 0, chapter: 0, section: 0 };
    sections.forEach(s => sectionsByLevel[s.level]++);
    console.log(`  Giornate: ${sectionsByLevel.giornata}, Capitoli: ${sectionsByLevel.chapter}, Sezioni: ${sectionsByLevel.section}`);

    const chunks = sectionsToChunks(sections);
    console.log(`Chunks creati: ${chunks.length}`);

    const avgSize = Math.round(chunks.reduce((s, c) => s + c.text.length, 0) / chunks.length);
    console.log(`Dimensione media chunk: ${avgSize} caratteri\n`);

    // Save
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const CHUNKS_PER_FILE = 50;
    const numFiles = Math.ceil(chunks.length / CHUNKS_PER_FILE);

    for (let i = 0; i < numFiles; i++) {
        const start = i * CHUNKS_PER_FILE;
        const fileChunks = chunks.slice(start, start + CHUNKS_PER_FILE).map(c => ({
            id: c.id,
            text: c.text,
            section: c.section,
            page: 0,
            pages: [],
            keywords: c.keywords
        }));

        const filename = path.join(OUTPUT_DIR, `chunks_${i}.json`);
        await fs.writeFile(filename, JSON.stringify(fileChunks, null, 2));
        const sizeMB = ((await fs.stat(filename)).size / 1024 / 1024).toFixed(2);
        console.log(`  chunks_${i}.json: ${fileChunks.length} chunks (${sizeMB} MB)`);
    }

    // Metadata
    const allKeywords = new Set();
    chunks.forEach(c => c.keywords.forEach(k => allKeywords.add(k)));

    const metadata = {
        version: '4.0-section-based',
        processedAt: new Date().toISOString(),
        courseName: COURSE_NAME,
        document: INPUT_PDF,
        stats: {
            totalPages: pdfData.numpages,
            totalSections: sections.length,
            totalChunks: chunks.length,
            totalCharacters: chunks.reduce((s, c) => s + c.text.length, 0),
            avgChunkSize: avgSize,
            totalKeywords: allKeywords.size,
            chunksPerFile: CHUNKS_PER_FILE,
            totalFiles: numFiles
        },
        sections: sections.map(s => ({ title: s.title, level: s.level }))
    };

    await fs.writeFile(path.join(OUTPUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));
    console.log(`\nMetadata salvato. ${chunks.length} chunks pronti.`);
}

main().catch(console.error);
