# scripts/deck-pdf.py — the `deckPdf` card: print the finished deck to deck/deck.pdf
# with headless Chrome, and assert the page count equals the slide count.
#
# Runs ONLY when the Clarify answers select a PDF (the default). The page-count
# assertion is the one the contract defines for the PDF: `deck-stage.js` injects
# `@page { size: <w>px <h>px }` from connectedCallback, so a print that fires before
# the component mounts paginates a 16:9 canvas onto Letter — right page count, wrong
# pages — which is why the virtual-time budget is not padding.
#
# Standard library only (python 3.8). stdout is protocol-reserved.
import json
import os
import re
import shutil
import subprocess

CHROMES = (
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
)
SECTION = re.compile(r'<section\b([^>]*)>', re.I)
PAGE = re.compile(rb'/Type\s*/Page[^s]')


def find_chrome():
    override = os.environ.get('WORCA_CHROME')
    if override and os.path.isfile(override):
        return override
    for c in CHROMES:
        p = shutil.which(c) or (c if os.path.isabs(c) and os.path.isfile(c) else None)
        if p:
            return p
    return None


def read_json(path):
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def answers_path(api):
    """deck-outputs.json in the pipeline dir: the deckOutputs answers. Read by path rather than
    through a wire (see presentation-workflow.mjs w37) — and the barrier on the builder guarantees
    it is final by the time any optional card runs."""
    return os.path.join(api.ctx.pipelineDir, 'deck-outputs.json')


def wants_pdf(answers):
    """PDF is the default: anything but an explicit opt-out prints one."""
    if not answers or not isinstance(answers, dict):
        return True
    values = answers.get('values')
    if isinstance(values, dict):
        d = str(values.get('deliverables', '')).lower()
    else:
        d = ''
        for q in answers.get('questions') or []:
            if isinstance(q, dict) and q.get('id') == 'deliverables' and isinstance(q.get('answer'), str):
                d = q['answer'].lower()
    return not d or 'pdf' in d


def live_slides(html):
    """<section> slides the print sheet keeps (data-deck-skip ones are hidden)."""
    return sum(1 for m in SECTION.finditer(html) if 'data-deck-skip' not in m.group(1))


def file_url(path):
    p = path.replace(os.sep, '/')
    return 'file://' + (p if p.startswith('/') else '/' + p)


def report(api, lines, issues, summary):
    body = '\n'.join(['# Deck PDF', ''] + lines) + '\n'
    for port in ('report', 'findings'):
        p = api.outputs.get(port) if hasattr(api.outputs, 'get') else None
        path = p.get('path') if p else None
        if path:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(body)
    return {'verdict': {'issues': issues, 'summary': summary}, 'summary': summary}


def main(api):
    pdir = api.ctx.pipelineDir
    answers = read_json(answers_path(api))
    if not wants_pdf(answers):
        return report(api, ['Skipped: a PDF was not requested.'], [], 'pdf skipped (not requested)')

    deck = os.path.join(pdir, 'deck', 'deck.html')
    out = os.path.join(pdir, 'deck', 'deck.pdf')
    if not os.path.isfile(deck):
        return report(api, ['No deck to print.'], [{
            'severity': 'critical', 'title': 'No deck to print',
            'detail': 'deck/deck.html does not exist in the pipeline directory.',
            'location': 'deck/deck.html'}], 'no deck')

    chrome = find_chrome()
    if not chrome:
        return report(api, ['No Chrome-family browser was found.'], [{
            'severity': 'major', 'title': 'No PDF: no Chrome-family browser',
            'detail': 'Looked for chrome/chromium/edge on PATH and the usual macOS/Windows install paths. '
                      'Set WORCA_CHROME to a binary, or deselect the PDF in the deliverables question.',
            'location': 'deck/deck.pdf'}], 'no chrome')

    if os.path.exists(out):
        os.remove(out)
    cmd = [chrome, '--headless=new', '--disable-gpu', '--use-mock-keychain', '--no-pdf-header-footer',
           '--virtual-time-budget=10000', '--print-to-pdf=' + out, file_url(deck)]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        return report(api, ['Chrome produced no PDF.'], [{
            'severity': 'major', 'title': 'PDF was not produced',
            'detail': 'The headless print exited without writing deck/deck.pdf.',
            'location': 'deck/deck.pdf'}], 'pdf missing')

    with open(out, 'rb') as fh:
        pages = len(PAGE.findall(fh.read()))
    with open(deck, encoding='utf-8', errors='replace') as fh:
        slides = live_slides(fh.read())
    issues = []
    if slides and pages != slides:
        issues.append({'severity': 'major',
                       'title': 'PDF has %d page(s) for %d slide(s)' % (pages, slides),
                       'detail': 'The print CSS paginated wrongly (the @page rule is injected by deck-stage.js on mount).',
                       'location': 'deck/deck.pdf'})
    summary = '%d slide(s), %d PDF page(s), %d bytes' % (slides, pages, os.path.getsize(out))
    return report(api, ['Printed deck/deck.pdf with `%s`.' % os.path.basename(chrome), summary], issues, summary)
