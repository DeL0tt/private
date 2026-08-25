#!/usr/bin/env python3
"""Verify watermarks-remover against the corpus, asserting exact outcomes.

Usage:  python3 build_corpus.py && python3 verify.py
Requires the service:  python3 service/scripts/server.py --host 127.0.0.1 --port 8765
"""
import base64, io, json, os, pathlib, struct, sys, unicodedata, urllib.request, zipfile, zlib

WM = os.environ.get("WATERMARKS_SERVICE_URL", "http://127.0.0.1:8765")
CORPUS = pathlib.Path(__file__).parent / "corpus"
results = []

def call(path, payload):
    req = urllib.request.Request(
        WM + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    # Bypass any HTTPS_PROXY: the service is loopback-only.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=60) as r:
        return json.load(r)

def payload(name):
    return {"file": base64.b64encode((CORPUS / name).read_bytes()).decode(), "name": name}

def check(label, actual, expected):
    ok = actual == expected
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        print(f"         expected={expected!r}\n         actual  ={actual!r}")

def invisibles(s):
    return [c for c in s if unicodedata.category(c) in ("Cf", "Mn") or c == " "]

def png_chunks(b):
    assert b[:8] == b"\x89PNG\r\n\x1a\n", "bad PNG signature"
    i, out = 8, []
    while i < len(b):
        ln = struct.unpack(">I", b[i:i+4])[0]
        typ, data = b[i+4:i+8], b[i+8:i+8+ln]
        crc = struct.unpack(">I", b[i+8+ln:i+12+ln])[0]
        assert crc == zlib.crc32(typ + data) & 0xFFFFFFFF, f"CRC fail on {typ!r}"
        out.append(typ.decode()); i += 12 + ln
    return out

def png_idat(b):
    i = 8
    while i < len(b):
        ln = struct.unpack(">I", b[i:i+4])[0]
        if b[i+4:i+8] == b"IDAT":
            return zlib.decompress(b[i+8:i+8+ln])
        i += 12 + ln

print(f"service: {WM}")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
health = json.load(opener.open(WM + "/health", timeout=10))
caps = json.load(opener.open(WM + "/capabilities", timeout=10))
check("service /health ok", health.get("ok"), True)
print(f"  optional tools: {caps['tools']}")
print(f"  text detectors: {caps['text_detectors']}")

print("\n[1] Layer A — invisible Unicode in Markdown")
ins = call("/inspect", payload("sample.md"))
check("inspect flags file suspicious", ins["suspicious"], True)
check("inspect finds all 8 planted codepoints", ins["report"]["suspicious_total"], 8)
cl = call("/clean", payload("sample.md"))
cleaned = base64.b64decode(cl["cleaned"]).decode()
check("clean removes every invisible", len(invisibles(cleaned)), 0)
check("visible text preserved", "Fünfte Zeile" in cleaned and "Testabsatz" in cleaned, True)

print("\n[2] Metadata — PNG (tEXt / iTXt-XMP / C2PA caBX)")
ins = call("/inspect", payload("sample.png"))
check("inspect detects C2PA container", ins["report"]["has_c2pa"], True)
check("inspect detects AI metadata", ins["report"]["has_ai_metadata"], True)
cl = call("/clean", payload("sample.png"))
out = base64.b64decode(cl["cleaned"])
check("only structural chunks remain", png_chunks(out), ["IHDR", "IDAT", "IEND"])
check("no residual C2PA", cl["report"]["still_has_c2pa"], False)
check("pixel data byte-identical", png_idat(out), png_idat((CORPUS / "sample.png").read_bytes()))

print("\n[3] Metadata — DOCX docProps")
cl = call("/clean", payload("sample.docx"))
z = zipfile.ZipFile(io.BytesIO(base64.b64decode(cl["cleaned"])))
core = z.read("docProps/core.xml").decode()
check("zip still valid", z.testzip() is None, True)
check("dc:creator scrubbed", "Anthropic" not in core and "Claude" not in core, True)
check("no residual AI metadata", cl["report"]["still_has_ai_metadata"], False)

print("\n[4] Metadata — SVG / HTML")
cl = call("/clean", payload("sample.html"))
html = base64.b64decode(cl["cleaned"]).decode()
check("html generator meta dropped", "Anthropic" not in html, True)
check("html ZWSP removed", len(invisibles(html)), 0)
cl = call("/clean", payload("sample.svg"))
svg = base64.b64decode(cl["cleaned"]).decode()
check("svg <metadata> dropped", "<metadata>" not in svg, True)
# Known gap, honestly self-reported by the tool rather than silently missed:
check("svg comment survives, and tool says so", cl["report"]["still_has_ai_metadata"], True)

print("\n[5] KNOWN BUG — /inspect blind to Layer A inside OOXML body text")
ins = call("/inspect", payload("zw_only.docx"))
cl = call("/clean", payload("zw_only.docx"))
print(f"  /inspect: suspicious={ins['suspicious']} total={ins['report']['suspicious_total']}")
print(f"  /clean  : {cl['report']['actions']}")
check("reproduces: inspect reports clean...", ins["suspicious"], False)
check("...while clean strips 3 invisibles", 
      any("removed=3" in a for a in cl["report"]["actions"]), True)

print("\n[6] Batch endpoints")
b = call("/clean/batch", {"files": [payload(n) for n in
        ("sample.svg", "sample.html", "sample.md", "sample.png")]})
check("all 4 batch entries ok", [r["ok"] for r in b["results"]], [True] * 4)

print(f"\n{'='*54}\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
