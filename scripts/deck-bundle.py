# scripts/deck-bundle.py — the `deckBundle` card: inline a built deck into ONE
# self-contained .html, then prove it reaches for nothing beside it.
#
# The headless twin of deck-export.js (which needs a browser and http) and of
# deck-kit/build-standalone.mjs (which stays in the kit as the fallback for hosts
# with no interpreter). Imports nothing from worca and nothing outside the
# standard library — it runs with WORCA_HOME stripped, on whatever interpreter
# the probe found — and must parse on python 3.8.
#
# stdout is protocol-reserved: the harness keeps a private handle for the result
# frame and points fd 1 at stderr, so print() goes to the run log.
import base64
import os
import re
import sys

MIME = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
}

SCRIPT_TAG = re.compile(r'<script([^>]*?)\ssrc=("|\')([^"\']+)\2([^>]*?)>\s*</script\s*>', re.I)
SHEET_TAG = re.compile(r'<link([^>]*?)\shref=("|\')([^"\']+)\2([^>]*?)>', re.I)
IMG_SRC = re.compile(r'(<img[^>]*?\ssrc=)("|\')([^"\']+)\2', re.I)
CSS_URL = re.compile(r'url\(\s*("|\')?([^"\')]+)\1?\s*\)', re.I)

# Stripped BEFORE the live-reference check, and this is not cosmetic. The kit's
# own source carries `<script src="deck-stage.js"></script>` in a header comment
# (deck-stage.js:57) and the bundler comments the audio tag out, so a naive
# whole-tag search reports a CORRECT bundle as broken — measured: the real
# docs/why-worca standalone matches such a search exactly once. Strip HTML
# comments and the bodies of inlined (src-less) scripts, and what is left is
# genuinely live markup.
HTML_COMMENT = re.compile(r'<!--.*?-->', re.S)
INLINED_SCRIPT = re.compile(r'<script(?![^>]*\ssrc=)[^>]*>.*?</script\s*>', re.I | re.S)
LIVE_SCRIPT = re.compile(r'<script[^>]*\ssrc=("|\')[^"\']+\1[^>]*>\s*</script\s*>', re.I)
LIVE_SHEET = re.compile(r'<link[^>]*rel=("|\')?stylesheet', re.I)


def is_remote(url):
    return bool(re.match(r'^(?:[a-z][a-z0-9+.-]*:|//)', url.strip(), re.I))


def mime_for(path):
    return MIME.get(os.path.splitext(path.split('?')[0].split('#')[0])[1].lower(),
                    'application/octet-stream')


def local_path(base_dir, href):
    return os.path.join(base_dir, href.split('?')[0].split('#')[0].lstrip('/'))


def data_uri(base_dir, href):
    path = local_path(base_dir, href)
    with open(path, 'rb') as fh:
        raw = fh.read()
    return 'data:' + mime_for(href) + ';base64,' + base64.b64encode(raw).decode('ascii')


def read_text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return fh.read()


def inline_css_urls(css, base_dir, missing):
    """Every local url() in a stylesheet becomes a data URI (webfonts, sprites)."""
    def swap(m):
        href = m.group(2)
        if is_remote(href) or href.startswith('data:'):
            return m.group(0)
        try:
            return 'url("' + data_uri(base_dir, href) + '")'
        except OSError:
            missing.append(href)
            return m.group(0)
    return CSS_URL.sub(swap, css)


def bundle(html, base_dir, missing, remote):
    """Inline every local companion. Order matters: scripts and sheets first (they
    can themselves reference assets), then the document's own img/style urls."""

    def swap_script(m):
        href = m.group(3)
        if is_remote(href):
            remote.append(href)
            return m.group(0)
        try:
            src = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return m.group(0)
        # A payload containing `</script` would close the tag early; the escape is
        # invisible to JS inside a string or comment and is the standard one.
        return '<script>/* ' + href + ' */\n' + src.replace('</script', '<\\/script') + '\n</script>'

    def swap_sheet(m):
        attrs = (m.group(1) or '') + (m.group(4) or '')
        href = m.group(3)
        if 'stylesheet' not in attrs.lower():
            return m.group(0)
        if is_remote(href):
            remote.append(href)
            return m.group(0)
        try:
            css = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return m.group(0)
        return '<style>/* ' + href + ' */\n' + inline_css_urls(css, base_dir, missing) + '\n</style>'

    def swap_img(m):
        href = m.group(3)
        if is_remote(href) or href.startswith('data:'):
            return m.group(0)
        try:
            return m.group(1) + '"' + data_uri(base_dir, href) + '"'
        except OSError:
            missing.append(href)
            return m.group(0)

    def swap_chunk(chunk):
        chunk = SCRIPT_TAG.sub(swap_script, chunk)
        chunk = SHEET_TAG.sub(swap_sheet, chunk)
        chunk = IMG_SRC.sub(swap_img, chunk)
        # The deck's own <style> block: @font-face and background urls live here,
        # because CONTRACT.md puts every rule in one inline block.
        return inline_css_urls(chunk, base_dir, missing)

    # A commented-out tag (e.g. a narration <script> the builder disabled) is not
    # live and must not be substituted — matching inside it would try to inline a
    # reference that was deliberately turned off, and fail if it is gone from
    # disk. Walk the HTML comments and leave their bodies untouched; only the
    # non-comment text between them is live markup subject to inlining.
    out = []
    pos = 0
    for m in HTML_COMMENT.finditer(html):
        out.append(swap_chunk(html[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(swap_chunk(html[pos:]))
    return ''.join(out)


def live_refs(doc):
    bare = INLINED_SCRIPT.sub('<script></script>', HTML_COMMENT.sub('', doc))
    return LIVE_SCRIPT.findall(bare), LIVE_SHEET.findall(bare)


def main(api):
    pdir = api.ctx.pipelineDir
    deck_dir = os.path.join(pdir, 'deck')
    source = os.path.join(deck_dir, 'deck.html')
    out_path = os.path.join(deck_dir, 'deck.standalone.html')

    issues = []
    if not os.path.isfile(source):
        issues.append({
            'severity': 'critical',
            'title': 'No deck to bundle',
            'detail': 'deck/deck.html does not exist in the pipeline directory.',
            'location': 'deck/deck.html',
        })
        return report(api, issues, None, 0)

    missing = []
    remote = []
    bundled = bundle(read_text(source), deck_dir, missing, remote)
    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write(bundled)
    size = os.path.getsize(out_path)
    print('bundled %s -> %s (%d bytes)' % (source, out_path, size))

    for href in sorted(set(remote)):
        issues.append({
            'severity': 'major',
            'title': 'The deck loads a remote asset, so it cannot be self-contained',
            'detail': 'deck.html references ' + href + '. CONTRACT.md forbids CDNs — they '
                      'fail silently under the artifact CSP. Copy the file into deck/ and '
                      'reference it relatively.',
            'location': 'deck/deck.html',
        })
    for href in sorted(set(missing)):
        issues.append({
            'severity': 'major',
            'title': 'A companion file the deck references is not on disk',
            'detail': 'deck.html references ' + href + ', which does not exist beside it, '
                      'so it could not be inlined.',
            'location': 'deck/' + href,
        })

    scripts, sheets = live_refs(bundled)
    if scripts or sheets:
        issues.append({
            'severity': 'major',
            'title': 'The bundle still reaches for a sibling file',
            'detail': '%d live <script src> and %d live stylesheet link(s) remain after '
                      'stripping HTML comments and inlined script bodies.' % (len(scripts), len(sheets)),
            'location': 'deck/deck.standalone.html',
        })

    return report(api, issues, out_path, size)


def report(api, issues, out_path, size):
    blocking = [i for i in issues if i['severity'] in ('critical', 'major')]
    summary = ('deck/deck.standalone.html — %d bytes, self-contained.' % size) if not blocking \
        else ('deck/deck.standalone.html — %d issue(s) block the deliverable.' % len(blocking))
    lines = ['# Deck bundle', '', summary, '']
    for i in issues:
        lines.append('- **[%s]** %s — %s' % (i['severity'], i['title'], i['detail']))
    if not issues:
        lines.append('No blocking findings.')
    body = '\n'.join(lines) + '\n'

    # `bundle` and `findings` share one filename, so this single write satisfies
    # both allocated paths whichever way the verdict goes.
    for port in ('bundle', 'findings'):
        p = api.outputs.get(port)
        path = p.get('path') if p else None
        if path:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(body)

    return {'verdict': {'issues': issues, 'summary': summary}, 'summary': summary}
