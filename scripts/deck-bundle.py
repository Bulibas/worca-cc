# scripts/deck-bundle.py — the `deckBundle` card: inline a built deck into ONE
# self-contained .html, then prove it reaches for nothing beside it.
#
# The headless twin of deck-export.js (which needs a browser and http) and of
# deck-kit/build-standalone.mjs (which stays in the kit as the fallback for hosts
# with no interpreter — and whose hard-won gotchas this program deliberately
# mirrors: unquoted src, type="module", defer/async, data-block script types).
# Imports nothing from worca and nothing outside the standard library — it runs
# with WORCA_HOME stripped, on whatever interpreter the probe found — and must
# parse on python 3.8.
#
# stdout is protocol-reserved: the harness keeps a private handle for the result
# frame and points fd 1 at stderr, so print() goes to the run log.
import base64
import os
import re

MIME = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
}

# The quoted-OR-unquoted alternation matters: `<script src=deck-stage.js>` is
# legal HTML. build-standalone.mjs:148-150 widened for exactly this, having
# shipped a version that missed it entirely and left a dead script that opens
# to a blank page with no log line. `\ssrc`, never `\bsrc`: `-` is a
# non-word character, so `\b` fires inside `data-src` too.
#
# The negative lookahead excludes data blocks (application/json, ld+json,
# text/template) from being treated as executable JS and pasted in as a plain
# <script> body — build-standalone.mjs:151 calls these out as "not code".
SCRIPT_TAG = re.compile(
    r'<script\b(?![^>]*\btype\s*=\s*["\']?(?:application/json|application/ld\+json|text/template))'
    r'([^>]*)\ssrc\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))([^>]*)>\s*</script\s*>', re.I)
SHEET_TAG = re.compile(r'<link([^>]*?)\shref=("|\')([^"\']+)\2([^>]*?)>', re.I)
IMG_SRC = re.compile(r'(<img[^>]*?\ssrc=)("|\')([^"\']+)\2', re.I)
CSS_URL = re.compile(r'url\(\s*("|\')?([^"\')]+)\1?\s*\)', re.I)
STYLE_BLOCK = re.compile(r'(<style\b[^>]*>)(.*?)(</style\s*>)', re.I | re.S)

# Strips defer/async from a <script>'s other attributes before re-emitting it
# inline: both are ignored on an inline classic script, so carrying them
# through changes WHEN the code runs (a deferred script that ran at parse
# position). `type="module"` is deliberately kept — dropping it silently turns
# a module into a classic script (`Cannot use import statement outside a
# module`) — see build-standalone.mjs:81-112.
DEFER_ASYNC = re.compile(r'(^|\s)(?:defer|async)(\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+))?', re.I)

# Stripped BEFORE the live-reference check, and this is not cosmetic. The
# kit's own source carries `<script src="deck-stage.js"></script>` in a header
# comment (deck-stage.js:57), and an author-written inline <script> data block
# can carry a literal, unescaped script-tag pair too (the real standalone's own
# notes block does, right beside its commented-out audio tag). A live-tag check
# that does not strip HTML comments AND inlined script bodies first reports a
# CORRECT bundle as broken. Unquoted src, again, for the same reason as above:
# a live but unquoted reference must be DETECTED, not silently certified clean.
HTML_COMMENT = re.compile(r'<!--.*?-->', re.S)
INLINED_SCRIPT = re.compile(r'<script(?![^>]*\ssrc=)[^>]*>.*?</script\s*>', re.I | re.S)
LIVE_SCRIPT = re.compile(
    r'<script\b[^>]*\ssrc\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)[^>]*>\s*</script\s*>', re.I)
LINK_TAG = re.compile(r'<link\b[^>]*>', re.I)
REL_ATTR = re.compile(r'\brel\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|(\S+))', re.I)
HREF_ATTR = re.compile(r'\shref\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)
SRC_ATTR = re.compile(r'\ssrc\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)


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


def keep_attrs(attrs):
    """Everything the original <script> declared except src (captured separately)
    and defer/async (meaningless — misleading — on an inline script)."""
    kept = DEFER_ASYNC.sub(r'\1', attrs).strip()
    return (' ' + re.sub(r'\s+', ' ', kept)) if kept else ''


def inline_css_urls(css, base_dir):
    """Every local url() in a stylesheet becomes a data URI (webfonts, sprites).
    Unresolvable and in-document (#fragment) references are left exactly as
    written, SILENTLY — this runs only over genuine CSS text (a <style> block's
    own content, or a stylesheet file's own content), never over the document
    at large, so "silent" here can never hide a real missing script or image."""
    def swap(m):
        href = m.group(2)
        if not href or href.startswith('#') or href.startswith('data:') or is_remote(href):
            return m.group(0)
        try:
            return 'url("' + data_uri(base_dir, href) + '")'
        except OSError:
            return m.group(0)
    return CSS_URL.sub(swap, css)


def rel_of(link_tag):
    m = REL_ATTR.search(link_tag)
    if not m:
        return ''
    return (m.group(1) or m.group(2) or m.group(3) or '').lower()


def attr_val(regex, tag):
    m = regex.search(tag)
    if not m:
        return None
    return m.group(1) if m.group(1) is not None else (
        m.group(2) if m.group(2) is not None else m.group(3))


def live_sheets(doc):
    """A live (not-yet-inlined) <link rel=stylesheet>. `stylesheet` need not be
    the whole rel value — `rel="preload stylesheet"` and `rel="stylesheet
    alternate"` are both real and both a live remote sheet spelled that way must
    still be caught, matching the substring check swap_sheet already uses to
    decide what to inline in the first place."""
    return [tag for tag in LINK_TAG.findall(doc) if 'stylesheet' in rel_of(tag)]


# A single, non-overlapping, left-to-right tokenizer over the whole document.
# Each alternative claims an ATOMIC region — an HTML comment, one whole <style>
# block, one whole <script> block, one <link> tag, one <img> tag — and nothing
# inside a claimed region is ever re-scanned by a different matcher. This is
# load-bearing, not tidiness: a <style> block's CSS_URL pass used to run over
# the WHOLE document, including every already-inlined JS payload — CSS_URL is
# case-insensitive and matches the literal "URL(" inside ordinary JS
# (`new URL(u, base)`, `a.href`, `createObjectURL(blob)`), turning routine code
# into false "missing companion" findings that blocked every successful run.
# And an author-written inline <script> data block can itself contain literal
# text shaped like a tag (e.g. a usage note quoting `<script src='x.js'>`) —
# scanning that text for a script/link/img match would try to inline data that
# was never a real reference. Comments, style bodies and script bodies are
# therefore all opaque: claimed whole, never descended into.
BUNDLE_TOKEN = re.compile(
    r'(?P<comment><!--.*?-->)'
    r'|(?P<style><style\b[^>]*>.*?</style\s*>)'
    r'|(?P<script><script\b[^>]*>.*?</script\s*>)'
    r'|(?P<link><link\b[^>]*>)'
    r'|(?P<img><img\b[^>]*>)', re.I | re.S)


def bundle(html, base_dir, missing, remote):
    """Inline every local companion, token by token (see BUNDLE_TOKEN)."""

    def handle_style(tag):
        m = STYLE_BLOCK.match(tag)
        open_tag, css, close_tag = m.group(1), m.group(2), m.group(3)
        if 'url(' not in css.lower():
            return tag
        return open_tag + inline_css_urls(css, base_dir) + close_tag

    def handle_script(tag):
        m = SCRIPT_TAG.match(tag)
        if not m:
            # No (inlineable) src: an author-written inline script, or a
            # data-block type (application/json, ld+json, text/template) the
            # kit deliberately treats as not-code. Either way, opaque — leave
            # entirely untouched, including whatever text it contains.
            return tag
        href = m.group(2) if m.group(2) is not None else (
            m.group(3) if m.group(3) is not None else m.group(4))
        if href.startswith('data:'):
            return tag
        if is_remote(href):
            remote.append(href)
            return tag
        try:
            src = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return tag
        attrs = keep_attrs((m.group(1) or '') + (m.group(5) or ''))
        # A payload containing `</script` would close the tag early; the escape is
        # invisible to JS inside a string or comment and is the standard one.
        return '<script' + attrs + '>/* ' + href + ' */\n' + src.replace('</script', '<\\/script') + '\n</script>'

    def handle_link(tag):
        m = SHEET_TAG.match(tag)
        if not m:
            return tag
        attrs = (m.group(1) or '') + (m.group(4) or '')
        href = m.group(3)
        if 'stylesheet' not in attrs.lower():
            return tag
        if href.startswith('data:'):
            return tag
        if is_remote(href):
            remote.append(href)
            return tag
        try:
            css = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return tag
        return '<style>/* ' + href + ' */\n' + inline_css_urls(css, base_dir) + '\n</style>'

    def handle_img(tag):
        # IMG_SRC only matches the `<img …src=` PREFIX up through the src value's
        # closing quote — by design, so it can also drive live_refs-style checks
        # on a partial span. Using `.match()` here and reconstructing from
        # `m.group(1)` alone silently discarded everything after the src
        # attribute, including the tag's own closing `>` — corrupting every
        # `<img>` that had any attribute after `src`, or any sibling markup right
        # after the tag. `.sub()` on the FULL tag replaces only the matched span
        # and leaves everything else — later attributes, `alt`, a trailing `/>`,
        # whatever follows in the document — untouched.
        def swap(m):
            href = m.group(3)
            if is_remote(href) or href.startswith('data:'):
                return m.group(0)
            try:
                return m.group(1) + '"' + data_uri(base_dir, href) + '"'
            except OSError:
                missing.append(href)
                return m.group(0)
        return IMG_SRC.sub(swap, tag, count=1)

    def dispatch(m):
        if m.group('comment') is not None:
            return m.group(0)
        if m.group('style') is not None:
            return handle_style(m.group(0))
        if m.group('script') is not None:
            return handle_script(m.group(0))
        if m.group('link') is not None:
            return handle_link(m.group(0))
        return handle_img(m.group(0))

    return BUNDLE_TOKEN.sub(dispatch, html)


def live_refs(doc):
    bare = INLINED_SCRIPT.sub('<script></script>', HTML_COMMENT.sub('', doc))
    return LIVE_SCRIPT.findall(bare), live_sheets(bare)


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

    # A live reference whose href is already a `remote` or `missing` finding is
    # not a SEPARATE problem — it is the same root cause, already reported with
    # a specific, actionable message (copy the file in; it's gone from disk).
    # This is the safety net for anything that slipped past those two checks
    # undetected, not a second alarm for the same fact: on the real
    # docs/why-worca/why-worca.html, the Google Fonts <link> is correctly ONE
    # remote finding, not one remote finding plus a duplicate generic one.
    explained = set(remote) | set(missing)

    def is_live(href):
        # A `data:` reference is already self-contained — swap_script/swap_sheet
        # exempt it from `remote` for exactly this reason, and the self-check
        # must agree, or a deck that legitimately inlines its own tiny script or
        # stylesheet as a data: URI blocks on a live reference to nothing.
        return href is not None and not href.startswith('data:') and href not in explained

    scripts, sheets = live_refs(bundled)
    scripts = [s for s in scripts if is_live(attr_val(SRC_ATTR, s))]
    sheets = [s for s in sheets if is_live(attr_val(HREF_ATTR, s))]
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
