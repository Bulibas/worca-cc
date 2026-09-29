# scripts/deck-bundle.py — the `deckBundle` card: inline a built deck into ONE
# self-contained .html, then prove it reaches for nothing beside it.
#
# The headless twin of deck-export.js (which needs a browser and http) and of
# deck-kit/build-standalone.mjs (which stays in the kit as the fallback for hosts
# with no interpreter — and whose hard-won gotchas this program deliberately
# mirrors: unquoted src, type="module", defer/async, data-block script types,
# the narration <audio>/<script> pair it has to special-case by hand).
#
# The deck HTML is written by an LLM from user-supplied material and the output is
# an artifact designed to be SHARED, so every path this program resolves is
# confined to the deck folder (see resolve_local) — an unsandboxed card that
# base64-embeds whatever a reference names is an exfiltration primitive.
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
    '.otf': 'font/otf', '.avif': 'image/avif',
    # MEDIA_SRC matches audio|video|source, so the table has to cover what they
    # carry. With only mp3/mp4 here an .m4a, .wav, .ogg or .webm was embedded as
    # application/octet-stream — no browser plays that back — while the card
    # still certified the bundle self-contained, because an unknown extension is
    # not a `missing`, `remote` or `escaped` finding anywhere. Kept in step with
    # mimeFor in build-standalone.mjs and deck-export.js.
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
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
# Quoted, single-quoted AND unquoted, with optional whitespace around `=`, like
# SCRIPT_TAG / MEDIA_SRC / HREF_ATTR / REL_ATTR — every other matcher in this file
# already tolerates all three spellings, and this one demanding `href="..."`
# exactly was not a stricter policy, just a gap. `<link rel=stylesheet
# href=theme.css>` was left verbatim and then surfaced as the generic blocking
# "the bundle still reaches for a sibling file", with no actionable detail, on a
# deck that was perfectly correct.
SHEET_TAG = re.compile(
    r'<link([^>]*?)\shref\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))([^>]*?)>', re.I)
# Quoted, single-quoted AND unquoted, over every element that fetches a file
# through a plain `src`. build-standalone.mjs:274-278 records the unquoted form as
# a SHIPPED bug — `<img src=logo.png>` "slipped through with NO log line", so the
# standalone went out with a dead relative reference — and :68-78 has to
# special-case the narration audio by hand. A narrated deck whose <audio> is
# dropped from a file called self-contained fails exactly as silently as a dead
# stylesheet, so the media elements are matched by the same pattern.
# `\ssrc`, never `\bsrc` (see SCRIPT_TAG). `srcset` can never match: `\s*=` has to
# follow `src` immediately, so a <source srcset> is simply not our business.
MEDIA_SRC = re.compile(
    r'(<(?:img|audio|video|source)\b[^>]*?\ssrc\s*=\s*)'
    r'(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)
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
# `\ssrc\s*=`, never `\ssrc=`: every other matcher in this file tolerates
# whitespace around the `=`, and this one alone did not. `<script src = "a.js">…`
# failed the lookahead, so BARE_TOKEN mistook a LIVE external script for an
# inlined one and erased it to `<script></script>` before live_refs ever looked —
# and SCRIPT_TAG misses it too (a non-empty body), so there was no `missing`
# finding either. A bundle that still fetched a sibling file was certified
# self-contained, which is the one verdict this whole self-check exists to prevent.
INLINED_SCRIPT = re.compile(r'<script(?![^>]*\ssrc\s*=)[^>]*>.*?</script\s*>', re.I | re.S)
# The BODY is `[\s\S]*?`, not `\s*`: `<script src="a.js">code</script>` — a src tag
# that also carries text — is matched by NEITHER SCRIPT_TAG nor the old
# `>\s*</script` form, so it stayed live and the bundle was still certified clean.
# Widening cannot produce a false positive: by the time this runs, every script
# this program inlined has had its `src` removed (keep_attrs) and every src-less
# script's body has been erased by BARE_TOKEN, so a `src` still attached to a
# script tag here is genuinely live. It is REPORTED rather than inlined on purpose
# — a browser ignores the body of a script that has a src, so inlining would pick
# one of two payloads on the author's behalf; the loop exists to send that back.
LIVE_SCRIPT = re.compile(
    r'<script\b[^>]*\ssrc\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s>]+)[^>]*>[\s\S]*?</script\s*>', re.I)
LINK_TAG = re.compile(r'<link\b[^>]*>', re.I)
REL_ATTR = re.compile(r'\brel\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|(\S+))', re.I)
HREF_ATTR = re.compile(r'\shref\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)
SRC_ATTR = re.compile(r'\ssrc\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', re.I)

# The two strips above, as ONE left-to-right alternation — built from their own
# patterns so the pair can never drift. Running them as two sequential
# substitutions is wrong in EITHER order: comments first lets an inlined payload's
# unbalanced `<!--` (deck-export.js carries `<!--` tokens today) eat forward to the
# next real `-->`, swallowing a genuinely live tag on the way; script bodies first
# lets an HTML comment containing a lone `<script>` swallow one the same way. One
# pass gives each token region to whichever STARTS first and never descends into a
# claimed region — the BUNDLE_TOKEN rule, one layer down.
#
# A <style> BODY is claimed for the same reason a script body is. handle_link
# turns every local sheet into `<style>…the sheet's own CSS…</style>`, and
# live_sheets then ran LINK_TAG over that CSS as if it were markup: a stylesheet
# carrying a usage header that quotes its own <link> — the exact idiom the kit's
# own sources use, and the reason script bodies are opaque here — surfaced as a
# blocking "the bundle still reaches for a sibling file" on a deck that is
# perfectly self-contained. is_live() cannot rescue it either: the href WAS
# inlined successfully, so it appears in none of remote/missing/escaped.
STYLE_BODY = re.compile(r'<style\b[^>]*>.*?</style\s*>', re.I | re.S)
BARE_TOKEN = re.compile(
    '(?P<comment>' + HTML_COMMENT.pattern + ')'
    + '|(?P<inlined>' + INLINED_SCRIPT.pattern + ')'
    + '|(?P<style>' + STYLE_BODY.pattern + ')',
    re.I | re.S)


def is_remote(url):
    return bool(re.match(r'^(?:[a-z][a-z0-9+.-]*:|//)', url.strip(), re.I))


def mime_for(path):
    return MIME.get(os.path.splitext(path.split('?')[0].split('#')[0])[1].lower(),
                    'application/octet-stream')


# CONFINEMENT, and it is a security boundary, not tidiness. This card runs
# UNSANDBOXED with worca's privileges over markup an LLM wrote from user-supplied
# material, and its product is an artifact meant to be sent to people: without
# this, `<script src="../../../../etc/hosts">` base64-embedded that file into the
# deliverable and the verdict was CLEAN. Stripping a leading `/` normalises
# nothing — it only turns an absolute href into a relative one that then walks
# straight back out with `..`. realpath on BOTH sides resolves `..`, `.`, doubled
# separators and symlinks (a symlink out of deck/ is exactly as much an escape as
# `..`, and CONTRACT.md tells the builder to COPY companions into deck/), and
# `+ os.sep` is what stops `/deck-evil/x` passing as inside `/deck`.
# build-standalone.mjs:localPath is the twin of this and now closes it the same way.
def resolve_local(base_dir, href, root=None):
    """The absolute path a local href names, or None when it escapes.

    `base_dir` is what the href is RELATIVE to; `root` is what it must stay
    INSIDE, defaulting to base_dir. They differ for a linked stylesheet, whose
    url()s resolve against its own folder but may legitimately point anywhere in
    the deck: conflating the two rejected `url("../img/a.png")` from
    `deck/css/theme.css` — a correct reference to `deck/img/a.png` — as an escape.
    """
    rel = href.split('?')[0].split('#')[0].lstrip('/')
    base = os.path.realpath(base_dir)
    top = base if root is None else os.path.realpath(root)
    path = os.path.realpath(os.path.join(base, rel))
    if path != top and not path.startswith(top + os.sep):
        return None
    return path


def data_uri(path, href):
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


def inline_css_urls(css, base_dir, escaped, missing, remote, root=None):
    """Every local url() in a stylesheet becomes a data URI (webfonts, sprites).
    In-document (#fragment) and data: references are left exactly as written.

    Everything else is REPORTED, and that is the whole point of the three lists.
    Silence here used to be defended as harmless — "it can never hide a real
    missing script or image" — but `background: url(hero.png)` is exactly a real
    missing image, and `@font-face { src: url("https://fonts.gstatic.com/...") }`
    is exactly the CDN reach CONTRACT.md bans because it fails silently under the
    artifact CSP. Neither was caught anywhere else either: the live-reference
    sweep only ever inspects <script src> and <link rel=stylesheet>. A deck that
    still fetched its fonts and its artwork over the network was certified
    self-contained. This is the same fix handle_media already carries."""
    def swap(m):
        href = m.group(2)
        if not href or href.startswith('#') or href.startswith('data:'):
            return m.group(0)
        if is_remote(href):
            remote.append(href)
            return m.group(0)
        path = resolve_local(base_dir, href, root)
        if path is None:
            escaped.append(href)
            return m.group(0)
        try:
            return 'url("' + data_uri(path, href) + '")'
        except OSError:
            missing.append(href)
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
# block, one whole <script> block, one <link> tag, one media START tag — and nothing
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
    # The START tag only, never the whole element: <audio>/<video> have children,
    # and a nested `<source src="…">` has to reach handle_media as its own token
    # instead of disappearing inside a claimed parent.
    r'|(?P<media><(?:img|audio|video|source)\b[^>]*>)', re.I | re.S)


def bundle(html, base_dir, missing, remote, escaped):
    """Inline every local companion, token by token (see BUNDLE_TOKEN)."""

    def handle_style(tag):
        m = STYLE_BLOCK.match(tag)
        # Guarded like its two siblings. BUNDLE_TOKEN and STYLE_BLOCK happen to
        # describe the same region today, which is the only reason an unguarded
        # dereference worked; the moment either pattern is edited alone this is an
        # AttributeError, and a crash here costs the whole execution, not one tag.
        if not m:
            return tag
        open_tag, css, close_tag = m.group(1), m.group(2), m.group(3)
        if 'url(' not in css.lower():
            return tag
        return open_tag + inline_css_urls(css, base_dir, escaped, missing, remote) + close_tag

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
        path = resolve_local(base_dir, href)
        if path is None:
            escaped.append(href)
            return tag
        try:
            src = read_text(path)
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
        attrs = (m.group(1) or '') + (m.group(5) or '')
        href = m.group(2) if m.group(2) is not None else (
            m.group(3) if m.group(3) is not None else m.group(4))
        if 'stylesheet' not in attrs.lower():
            return tag
        if href.startswith('data:'):
            return tag
        if is_remote(href):
            remote.append(href)
            return tag
        path = resolve_local(base_dir, href)
        if path is None:
            escaped.append(href)
            return tag
        try:
            css = read_text(path)
        except OSError:
            missing.append(href)
            return tag
        # THE STYLESHEET'S OWN FOLDER. A url() in a linked sheet is relative to
        # the sheet, not to the document: `<link href="css/theme.css">` carrying
        # `url("fonts/I.woff2")` means deck/css/fonts/I.woff2, and resolving it
        # against deck/ missed the file — which, before the fix above, was
        # swallowed in silence and shipped an unembedded font. The same
        # conflation turned `url("../img/a.png")` — a correct reference to
        # deck/img/a.png — into a BLOCKING "outside its own folder" finding that
        # sent a perfectly good deck back into the fix loop. The deck folder
        # stays the confinement root, which is what keeps both halves true.
        # build-standalone.mjs has resolved against the sheet's own folder all
        # along; this card, now the primary path, had not.
        return '<style>/* ' + href + ' */\n' \
            + inline_css_urls(css, os.path.dirname(path), escaped, missing, remote, base_dir) \
            + '\n</style>'

    def handle_media(tag):
        # MEDIA_SRC only matches the `<img|audio|video|source …src=` PREFIX up
        # through the src value — by design, so it can also drive live_refs-style
        # checks on a partial span. Using `.match()` here and reconstructing from
        # `m.group(1)` alone silently discarded everything after the src
        # attribute, including the tag's own closing `>` — corrupting every
        # `<img>` that had any attribute after `src`, or any sibling markup right
        # after the tag. `.sub()` on the FULL tag replaces only the matched span
        # and leaves everything else — later attributes, `alt`, a trailing `/>`,
        # whatever follows in the document — untouched.
        def swap(m):
            href = m.group(2) if m.group(2) is not None else (
                m.group(3) if m.group(3) is not None else m.group(4))
            if not href or href.startswith('data:'):
                return m.group(0)
            if is_remote(href):
                # REPORTED, not silently skipped. A remote image is the likeliest
                # CDN reach a deck makes, and returning early without recording it
                # certified a bundle that still fetches over the network as
                # self-contained: the live-reference sweep only ever looked at
                # scripts and stylesheets, so nothing else caught it either.
                # CONTRACT.md bans CDNs because they fail SILENTLY under the
                # artifact CSP — which is this card's whole reason to exist.
                remote.append(href)
                return m.group(0)
            path = resolve_local(base_dir, href)
            if path is None:
                escaped.append(href)
                return m.group(0)
            try:
                return m.group(1) + '"' + data_uri(path, href) + '"'
            except OSError:
                missing.append(href)
                return m.group(0)
        return MEDIA_SRC.sub(swap, tag, count=1)

    def dispatch(m):
        if m.group('comment') is not None:
            return m.group(0)
        if m.group('style') is not None:
            return handle_style(m.group(0))
        if m.group('script') is not None:
            return handle_script(m.group(0))
        if m.group('link') is not None:
            return handle_link(m.group(0))
        return handle_media(m.group(0))

    return BUNDLE_TOKEN.sub(dispatch, html)


def live_refs(doc):
    # ONE pass (see BARE_TOKEN): an HTML comment is erased, an inlined script keeps
    # an empty carcass so the document still parses as it did. Never two
    # substitutions — either order lets one construct eat the other's region, and
    # what gets eaten is a live reference this check exists to find.
    def strip(m):
        if m.group('comment') is not None:
            return ''
        # An empty carcass for both, so the document still parses as it did: a
        # <style> region must not collapse into a <script> one.
        return '<style></style>' if m.group('style') is not None else '<script></script>'
    bare = BARE_TOKEN.sub(strip, doc)
    return LIVE_SCRIPT.findall(bare), live_sheets(bare)


# The `built` input is deck-manifest.md, and the one fact in it this card can use
# is the slide count — a bundle is one file whether it holds 3 slides or 30, so the
# number belongs in the SUMMARY a human reads beside the byte count, not in a gate.
# Defensive to the point of paranoia, and deliberately so: the port may be
# unbound, the file may not exist, and the manifest is agent-written prose that
# can be reshaped at any time. Every one of those is a missing slide count, never
# a failed card — this program's verdict must depend only on the deck it bundled.
MANIFEST_SLIDES = re.compile(r'\bSlides\s*:\s*(\d+)', re.I)


def slide_count(api):
    """The slide count named by the bound `built` manifest, or None."""
    try:
        port = api.inputs.get('built') if hasattr(api.inputs, 'get') else None
        path = port.get('path') if port else None
        if not path:
            return None
        m = MANIFEST_SLIDES.search(read_text(path))
        return int(m.group(1)) if m else None
    except Exception:            # ANY of them: this is a log detail, never a gate
        return None


def wants_standalone(api):
    """The single-file HTML is a default deliverable: only an explicit opt-out skips it.

    Reads the Clarify answers the same way scripts/deck-pdf.py does — a form's flat
    `values` map, or the clarifier's question records — and treats anything
    unreadable as "yes", so a missing or malformed answers file never costs the
    user their deliverable."""
    try:
        import json
        # deck-outputs.json in the pipeline dir — by path, not by wire (see presentation-workflow.mjs w37).
        with open(os.path.join(api.ctx.pipelineDir, 'deck-outputs.json'), encoding='utf-8') as fh:
            answers = json.load(fh)
        if not isinstance(answers, dict):
            return True
        values = answers.get('values')
        if isinstance(values, dict):
            d = str(values.get('deliverables', '')).lower()
        else:
            d = ''
            for q in answers.get('questions') or []:
                if isinstance(q, dict) and q.get('id') == 'deliverables' and isinstance(q.get('answer'), str):
                    d = q['answer'].lower()
        return not d or 'standalone' in d
    except Exception:
        return True


def main(api):
    pdir = api.ctx.pipelineDir
    if not wants_standalone(api):
        return report(api, [], None, 0, None, skipped='the single-file HTML was not requested')
    deck_dir = os.path.join(pdir, 'deck')
    source = os.path.join(deck_dir, 'deck.html')
    out_path = os.path.join(deck_dir, 'deck.standalone.html')

    slides = slide_count(api)
    issues = []
    if not os.path.isfile(source):
        issues.append({
            'severity': 'critical',
            'title': 'No deck to bundle',
            'detail': 'deck/deck.html does not exist in the pipeline directory.',
            'location': 'deck/deck.html',
        })
        return report(api, issues, None, 0, slides)

    missing = []
    remote = []
    escaped = []
    bundled = bundle(read_text(source), deck_dir, missing, remote, escaped)
    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write(bundled)
    size = os.path.getsize(out_path)
    print('bundled %s -> %s (%d bytes%s)'
          % (source, out_path, size, '' if slides is None else ', %d slides' % slides))

    for href in sorted(set(remote)):
        issues.append({
            'severity': 'major',
            'title': 'The deck loads a remote asset, so it cannot be self-contained',
            'detail': 'deck.html references ' + href + '. CONTRACT.md forbids CDNs — they '
                      'fail silently under the artifact CSP. Copy the file into deck/ and '
                      'reference it relatively.',
            'location': 'deck/deck.html',
        })
    for href in sorted(set(escaped)):
        issues.append({
            'severity': 'major',
            'title': 'The deck references a file outside its own folder',
            'detail': 'deck.html references ' + href + ', which resolves outside deck/. '
                      'Nothing outside the deck folder is read or inlined — the bundle is '
                      'built from deck/ alone. Copy the file into deck/ and reference it '
                      'relatively.',
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
    explained = set(remote) | set(missing) | set(escaped)

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

    return report(api, issues, out_path, size, slides)


def report(api, issues, out_path, size, slides=None, skipped=None):
    blocking = [i for i in issues if i['severity'] in ('critical', 'major')]
    count = '' if slides is None else ', %d slide(s)' % slides
    summary = ('skipped: %s.' % skipped) if skipped else \
        ('deck/deck.standalone.html — %d bytes%s, self-contained.' % (size, count)) if not blocking \
        else ('deck/deck.standalone.html%s — %d issue(s) block the deliverable.' % (count, len(blocking)))
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
