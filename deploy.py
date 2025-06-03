#!/usr/bin/env python3
"""Deploy the local JavaScript file to the English Wikipedia.

This script performs two roles:
1. **Branch‑aware transformation** – When deploying the *dev* branch we need to:
   * change `CONFIG_PAGE` so that the development copy reads its JSON from
     `User:L235/form-config.json` instead of the production page; and
   * disable the early‑exit that prevents the script from running away from the
     production base page.
2. Upload the (possibly transformed) file to the supplied wiki page.

Credentials come from the `user-password.py` file that the workflow writes just
before running this script. That file should contain a single line like::

    ('L235', BotPassword('bot‑name', 'bot‑password'))

See <https://www.mediawiki.org/wiki/Manual:Pywikibot/Bot_passwords> for details.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

import pywikibot


def _transform_for_dev(js: str) -> str:
    """Apply dev‑only tweaks to the script source."""
    # 1. Point CONFIG_PAGE at user‑space JSON
    js = re.sub(
        r"var\s+CONFIG_PAGE\s*=\s*'Mediawiki:Form-assistant.js/config.json';",
        "var CONFIG_PAGE = 'User:L235/form-config.json';",
        js,
    )

    # 2. Comment out the silent early‑return guard
    js = re.sub(
        r"^(\s*)return;\s*//\s*Silently\s+exit.*$",
        r"\1// return; // Silently exit – disabled in dev",
        js,
        flags=re.MULTILINE,
    )

    return js


def deploy(branch: str, source: Path, target: str, summary: str) -> None:
    """Deploy *source* to *target* with the given edit *summary*."""
    js_text = source.read_text(encoding="utf-8")

    if branch.lower() == "dev":
        js_text = _transform_for_dev(js_text)

    site = pywikibot.Site("en", "wikipedia")
    page = pywikibot.Page(site, target)
    page.text = js_text
    page.save(summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deploy formAssistant.js to Wikipedia")
    parser.add_argument("--branch", required=True, help="Git branch being deployed (dev or main)")
    parser.add_argument("--file", required=True, help="Path to the JS source file")
    parser.add_argument("--target", required=True, help="Full title of the wiki page to overwrite")
    parser.add_argument("--summary", required=True, help="Edit summary text")

    args = parser.parse_args()
    deploy(args.branch, Path(args.file), args.target, args.summary)