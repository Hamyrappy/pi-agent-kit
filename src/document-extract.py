#!/usr/bin/env python3
"""Bounded local text extraction for PDF and DOCX, without model/provider calls."""
import pathlib
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_FILE = 20 * 1024 * 1024
MAX_XML = 2 * 1024 * 1024
MAX_TEXT = 200000


def extract(filename):
    file = pathlib.Path(filename)
    if not file.is_file() or file.stat().st_size > MAX_FILE:
        raise ValueError('Document is missing or exceeds 20 MB')
    kind = file.suffix.lower()
    if kind == '.docx':
        with zipfile.ZipFile(file) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > MAX_XML:
                raise ValueError('DOCX document text is too large')
            root = ET.fromstring(archive.read(info))
        ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        text = '\n'.join(''.join(node.itertext()) for node in root.iter(ns + 'p'))
    elif kind == '.pdf':
        # Bound pages and output on disk, avoiding an unbounded PIPE capture.
        import tempfile
        import os
        import resource
        def limit_output():
            resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 * 1024, 4 * 1024 * 1024))
        with tempfile.TemporaryDirectory(prefix='pi-pdf-') as tmp:
            output = pathlib.Path(tmp) / 'text.txt'
            result = subprocess.run(['pdftotext', '-f', '1', '-l', '40', '-enc', 'UTF-8', str(file.resolve()), str(output)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12, preexec_fn=limit_output)
            if result.returncode:
                raise ValueError('Cannot extract PDF text (encrypted, damaged or too large)')
            text = output.read_text(errors='replace')
        text += '\n[PDF extraction is limited to the first 40 pages.]'
    else:
        raise ValueError('Only PDF and DOCX are supported by this extractor')
    if not text.strip() or text.strip() == '[PDF extraction is limited to the first 40 pages.]':
        raise ValueError('No readable text found. A scanned document requires OCR.')
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + '\n[Text truncated at 200000 characters.]'
    return text


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: document-extract.py FILE')
        print(extract(sys.argv[1]))
    except (ValueError, OSError, zipfile.BadZipFile, KeyError, ET.ParseError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
