#!/usr/bin/env python3
"""Reproduction script: independent measurement of embedded base64 assets in DSH client bundles.

Read-only. Does not touch the running dsh-web service, ~/.dsh, or the original repository.
Run:  python3 docs/evidence/webui-embedded-assets-repro.py [--install DIR]
"""

import argparse, glob, gzip, json, os, re, sys

DEFAULT_INSTALL = (
    '/home/sahen/.local/opt/dsh-original/lib/node_modules/@deepseek-ai/dsh'
    '/node_modules/@deepseek-ai/'
)

DATA_URI = re.compile(r'data:image/[A-Za-z0-9.+-]+;base64,')


def collect_client_bundles(install):
    """Return sorted paths of every <pkg>/lib/client.js under the install root."""
    found = glob.glob(os.path.join(install, '*/lib/client.js'))
    return sorted(os.path.realpath(p) for p in found)


def scan_uri(text, start):
    """Return (end_of_uri, end_of_payload) for a data: URI match starting at `start`."""
    m = DATA_URI.match(text, start)
    if not m:
        return None
    j = m.end()
    while j < len(text) and (text[j].isalnum() or text[j] in '+/='):
        j += 1
    return m.end(), j


def measure(install):
    files = collect_client_bundles(install)
    total_bytes = total_chars = 0
    with_prefix = without_prefix = 0
    uri_count = 0
    per_file = []
    mime_counts = {}
    payload_blobs = []
    for path in files:
        raw = open(path, 'rb').read()
        text = raw.decode('utf-8')
        total_bytes += len(raw)
        total_chars += len(text)
        f_with = 0
        for m in DATA_URI.finditer(text):
            span = scan_uri(text, m.start())
            if not span:
                continue
            end_prefix, end_payload = span
            span_chars = end_payload - m.start()
            with_prefix += span_chars
            without_prefix += end_payload - end_prefix
            f_with += span_chars
            uri_count += 1
            mime = m.group(0)
            mime_counts[mime] = mime_counts.get(mime, 0) + 1
            payload_blobs.append(text[m.start():end_payload])
        per_file.append((f_with, path))
    per_file.sort(reverse=True)
    return {
        'install': install,
        'file_count': len(files),
        'total_bytes': total_bytes,
        'total_chars': total_chars,
        'uri_count': uri_count,
        'base64_chars_with_prefix': with_prefix,
        'base64_chars_without_prefix': without_prefix,
        'pct_with_prefix': round(100.0 * with_prefix / total_chars, 3),
        'pct_without_prefix': round(100.0 * without_prefix / total_chars, 3),
        'mime_counts': mime_counts,
        'per_file_top': [
            {'chars': n, 'package': os.path.relpath(p, install).split(os.sep)[0]}
            for n, p in per_file[:10]
        ],
        '_blobs': payload_blobs,
    }


def gzip_probe(result):
    """Compare gzip ratio of embedded base64 vs the rest of the bundle text."""
    install = result['install']
    raw = b''.join(open(p, 'rb').read() for p in collect_client_bundles(install))
    text = raw.decode('utf-8')
    blobs = result['_blobs']
    b64 = ''.join(blobs).encode('utf-8')
    stripped = DATA_URI.sub('', text)
    stripped = re.sub(r'[A-Za-z0-9+/=]{40,}', '', stripped)
    rest = stripped.encode('utf-8')
    return {
        'all_raw': len(raw),
        'all_gzip': len(gzip.compress(raw, 9)),
        'all_ratio': round(len(gzip.compress(raw, 9)) / len(raw), 4),
        'base64_raw': len(b64),
        'base64_gzip': len(gzip.compress(b64, 9)),
        'base64_ratio': round(len(gzip.compress(b64, 9)) / len(b64), 4),
        'rest_raw': len(rest),
        'rest_gzip': len(gzip.compress(rest, 9)),
        'rest_ratio': round(len(gzip.compress(rest, 9)) / len(rest), 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--install', default=DEFAULT_INSTALL)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    if not os.path.isdir(a.install):
        sys.exit('install dir not found: %s' % a.install)
    r = measure(a.install)
    g = gzip_probe(r)
    blobs = r.pop('_blobs')
    out = {'measurement': r, 'gzip': g}
    if a.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return
    print('install                : %s' % r['install'])
    print('client.js files        : %d' % r['file_count'])
    print('total bytes            : %d' % r['total_bytes'])
    print('total chars            : %d' % r['total_chars'])
    print('data:image URIs        : %d' % r['uri_count'])
    print('base64 chars (w/ prefix): %d  (%.3f%% of chars)'
          % (r['base64_chars_with_prefix'], r['pct_with_prefix']))
    print('base64 chars (payload) : %d  (%.3f%% of chars)'
          % (r['base64_chars_without_prefix'], r['pct_without_prefix']))
    print()
    print('mime histogram:')
    for k, v in sorted(r['mime_counts'].items(), key=lambda kv: -kv[1]):
        print('  %-32s %d' % (k, v))
    print()
    print('top files by embedded chars:')
    for e in r['per_file_top']:
        print('  %10d  %s' % (e['chars'], e['package']))
    print()
    print('gzip probe:')
    for k, v in g.items():
        print('  %-14s %s' % (k, v))


if __name__ == '__main__':
    main()