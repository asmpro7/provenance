#!/usr/bin/env python3
"""Build the Provenance .xpi (a plain zip of the plugin files).

Usage:  python3 build.py [version]
Reads the version from manifest.json when not given.
"""
import base64
import json
import os
import re
import sys
import zipfile

FILES = [
    "manifest.json",
    "bootstrap.js",
    "main.js",
    "prefs.js",
    "preferences.xhtml",
    "preferences.js",
    "icons/icon.svg",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-96.png",
]

here = os.path.dirname(os.path.abspath(__file__))

# Keep the report favicon (a base64 constant in main.js) in sync with the
# packaged icon on every build, so the report's tab icon is always the
# current plugin icon.
icon_path = os.path.join(here, "icons", "icon-32.png")
main_path = os.path.join(here, "main.js")
if os.path.exists(icon_path):
    b64 = base64.b64encode(open(icon_path, "rb").read()).decode("ascii")
    src = open(main_path, encoding="utf-8").read()
    new, n = re.subn(r"REPORT_ICON_B64: '[A-Za-z0-9+/=]*'",
                     "REPORT_ICON_B64: '%s'" % b64, src, count=1)
    if n:
        open(main_path, "w", encoding="utf-8").write(new)
        print("favicon constant refreshed from icons/icon-32.png")

manifest = json.load(open(os.path.join(here, "manifest.json")))
version = sys.argv[1] if len(sys.argv) > 1 else manifest["version"]
out = os.path.join(here, "provenance-%s.xpi" % version)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(os.path.join(here, f), f)
print("built", out)
