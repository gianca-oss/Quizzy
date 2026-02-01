#!/usr/bin/env python3
"""
Script per processare il PDF del corso e generare chunks per Quizzy.
Esegui: python scripts/process-pdf.py

Requisiti:
    pip install PyPDF2
    (oppure: pip install pdfplumber per PDF più complessi)
"""

import os
import json
import re
import sys
from pathlib import Path
from datetime import datetime

# Prova prima PyPDF2, poi pdfplumber
try:
    from PyPDF2 import PdfReader
    PDF_LIBRARY = 'PyPDF2'
except ImportError:
    try:
        import pdfplumber
        PDF_LIBRARY = 'pdfplumber'
    except ImportError:
        print("❌ Errore: installa PyPDF2 o pdfplumber")
        print("   pip install PyPDF2")
        print("   oppure: pip install pdfplumber")
        sys.exit(1)

# Configurazione
CHUNK_SIZE = 500  # Caratteri per chunk
CHUNK_OVERLAP = 100  # Overlap tra chunks per contesto
CHUNKS_PER_FILE = 100  # Chunks per file JSON

# Paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
SOURCE_DIR = PROJECT_DIR / "data" / "source"
OUTPUT_DIR = PROJECT_DIR / "data" / "processed"


def extract_text_pypdf2(pdf_path):
    """Estrae testo usando PyPDF2"""
    reader = PdfReader(pdf_path)
    pages = []

    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        pages.append({
            "page": i + 1,
            "text": text.strip()
        })
        print(f"  📄 Pagina {i + 1}/{len(reader.pages)}")

    return pages


def extract_text_pdfplumber(pdf_path):
    """Estrae testo usando pdfplumber (migliore per PDF complessi)"""
    import pdfplumber
    pages = []

    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            pages.append({
                "page": i + 1,
                "text": text.strip()
            })
            print(f"  📄 Pagina {i + 1}/{len(pdf.pages)}")

    return pages


def clean_text(text):
    """Pulisce il testo estratto"""
    # Rimuovi caratteri strani
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text)
    # Normalizza spazi
    text = re.sub(r'\s+', ' ', text)
    # Rimuovi righe vuote multiple
    text = re.sub(r'\n\s*\n', '\n\n', text)
    return text.strip()


def create_chunks(pages, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """Divide il testo in chunks con overlap"""
    chunks = []
    chunk_id = 0

    for page_data in pages:
        page_num = page_data["page"]
        text = clean_text(page_data["text"])

        if not text:
            continue

        # Dividi in chunks
        start = 0
        while start < len(text):
            end = start + chunk_size
            chunk_text = text[start:end]

            # Cerca di terminare a fine frase
            if end < len(text):
                last_period = chunk_text.rfind('.')
                last_newline = chunk_text.rfind('\n')
                break_point = max(last_period, last_newline)

                if break_point > chunk_size * 0.5:
                    chunk_text = chunk_text[:break_point + 1]
                    end = start + break_point + 1

            if chunk_text.strip():
                chunks.append({
                    "id": chunk_id,
                    "page": page_num,
                    "text": chunk_text.strip()
                })
                chunk_id += 1

            # Prossimo chunk con overlap
            start = end - overlap if end < len(text) else len(text)

    return chunks


def save_chunks(chunks, output_dir, chunks_per_file=CHUNKS_PER_FILE):
    """Salva chunks in file JSON multipli"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Rimuovi vecchi file
    for old_file in output_dir.glob("chunks_*.json"):
        old_file.unlink()

    # Salva in file da 100 chunks ciascuno
    num_files = (len(chunks) + chunks_per_file - 1) // chunks_per_file

    for i in range(num_files):
        start_idx = i * chunks_per_file
        end_idx = min((i + 1) * chunks_per_file, len(chunks))
        file_chunks = chunks[start_idx:end_idx]

        output_file = output_dir / f"chunks_{i}.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(file_chunks, f, ensure_ascii=False, indent=2)

        print(f"  💾 {output_file.name}: {len(file_chunks)} chunks")

    return num_files


def save_metadata(chunks, pages, output_dir, pdf_name):
    """Salva metadata.json"""
    metadata = {
        "version": "4.0",
        "source": pdf_name,
        "processedAt": datetime.now().isoformat(),
        "totalChunks": len(chunks),
        "totalPages": len(pages),
        "chunkSize": CHUNK_SIZE,
        "chunkOverlap": CHUNK_OVERLAP
    }

    output_file = Path(output_dir) / "metadata.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    print(f"  📋 metadata.json salvato")
    return metadata


def main():
    print("=" * 50)
    print("🚀 QUIZZY - Processamento PDF")
    print("=" * 50)

    # Trova PDF nella cartella source
    pdf_files = list(SOURCE_DIR.glob("*.pdf"))

    if not pdf_files:
        print(f"\n❌ Nessun PDF trovato in: {SOURCE_DIR}")
        print(f"   Copia il tuo PDF in quella cartella e riprova.")
        print(f"\n   Esempio:")
        print(f"   cp ~/Downloads/corso.pdf {SOURCE_DIR}/corso.pdf")
        sys.exit(1)

    if len(pdf_files) > 1:
        print(f"\n⚠️  Trovati {len(pdf_files)} PDF. Processo tutti:")
        for pdf in pdf_files:
            print(f"   - {pdf.name}")

    all_chunks = []
    all_pages = []

    for pdf_path in pdf_files:
        print(f"\n📖 Elaborazione: {pdf_path.name}")
        print(f"   Libreria: {PDF_LIBRARY}")

        # Estrai testo
        print("\n1️⃣  Estrazione testo...")
        if PDF_LIBRARY == 'PyPDF2':
            pages = extract_text_pypdf2(pdf_path)
        else:
            pages = extract_text_pdfplumber(pdf_path)

        all_pages.extend(pages)

        # Crea chunks
        print(f"\n2️⃣  Creazione chunks (size={CHUNK_SIZE}, overlap={CHUNK_OVERLAP})...")
        chunks = create_chunks(pages)

        # Aggiorna ID per chunks multipli PDF
        for chunk in chunks:
            chunk["id"] = len(all_chunks) + chunk["id"]
            chunk["source"] = pdf_path.name

        all_chunks.extend(chunks)
        print(f"   ✅ {len(chunks)} chunks creati da {pdf_path.name}")

    # Salva tutto
    print(f"\n3️⃣  Salvataggio in {OUTPUT_DIR}...")
    num_files = save_chunks(all_chunks, OUTPUT_DIR)

    pdf_names = ", ".join([p.name for p in pdf_files])
    metadata = save_metadata(all_chunks, all_pages, OUTPUT_DIR, pdf_names)

    # Riepilogo
    print("\n" + "=" * 50)
    print("✅ COMPLETATO!")
    print("=" * 50)
    print(f"   📄 Pagine processate: {len(all_pages)}")
    print(f"   📦 Chunks totali: {len(all_chunks)}")
    print(f"   📁 File generati: {num_files + 1}")
    print(f"\n   Prossimi passi:")
    print(f"   1. git add data/processed")
    print(f"   2. git commit -m 'Update corso'")
    print(f"   3. git push")
    print("=" * 50)


if __name__ == "__main__":
    main()
