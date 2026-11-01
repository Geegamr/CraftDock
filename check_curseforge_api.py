#!/usr/bin/env python3
"""Check whether CraftDock's configured key can search CurseForge Minecraft mods.

Uses CF_API_KEY from the process environment when set; otherwise the key
embedded for packaged builds (cf-key.js), then the legacy main.js fallback. This
script never reads .env or prints the key.
"""

import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "https://api.curseforge.com/v1"
PROJECT_ROOT = Path(__file__).resolve().parent


def get_api_key():
    key = os.environ.get("CF_API_KEY", "").strip()
    if key:
        return key, "CF_API_KEY environment variable"

    main_js = (PROJECT_ROOT / "main.js").read_text(encoding="utf-8")
    match = re.search(
        r"const\s+CF_API_KEY\s*=\s*process\.env\.CF_API_KEY\s*\|\|\s*(['\"])(.*?)\1\s*;",
        main_js,
    )
    if match and match.group(2).strip():
        return match.group(2).strip(), "main.js fallback"

    # Packaged builds embed the key through scripts/embed-cf-key.js as a masked
    # byte array, which main.js decodes in memory.
    embedded = PROJECT_ROOT / "cf-key.js"
    if embedded.is_file():
        text = embedded.read_text(encoding="utf-8")
        data = re.search(r"data:\s*\[([^\]]*)\]", text)
        mask = re.search(r"mask:\s*\[([^\]]*)\]", text)
        if data and mask:
            try:
                plain = bytes(
                    int(byte) ^ int(pad)
                    for byte, pad in zip(
                        data.group(1).split(","),
                        mask.group(1).split(","),
                    )
                    if byte.strip() and pad.strip()
                )
                key = plain.decode("utf-8").strip()
            except (ValueError, UnicodeDecodeError):
                key = ""
            if key:
                return key, "cf-key.js embedded build key"
    return None, None


def main():
    api_key, key_source = get_api_key()
    if not api_key:
        print("No CurseForge API key found in the process environment or main.js fallback.")
        print("Set CF_API_KEY in your shell and rerun; .env is intentionally not read.")
        return 2

    params = urlencode(
        {
            "gameId": 432,
            "classId": 6,
            "searchFilter": "jei",
            "pageSize": 5,
            "index": 0,
            "sortField": 2,
            "sortOrder": "desc",
        }
    )
    request = Request(
        f"{BASE_URL}/mods/search?{params}",
        headers={"Accept": "application/json", "x-api-key": api_key},
        method="GET",
    )

    print(f"Testing CurseForge Minecraft mods search (key source: {key_source}; key hidden).")
    print("Request: GET /v1/mods/search?gameId=432&classId=6&searchFilter=jei&pageSize=5")

    try:
        with urlopen(request, timeout=20) as response:
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        print(f"CurseForge returned HTTP {error.code}.")
        if error.code in (401, 403):
            print("The key was rejected or is not authorized for this API. Check the key in the CurseForge developer console.")
        elif error.code == 429:
            print("The API rate limit was reached; try again later.")
        return 1
    except (URLError, TimeoutError, OSError) as error:
        print(f"Could not reach CurseForge: {error.reason if isinstance(error, URLError) else error}")
        return 1
    except (UnicodeDecodeError, json.JSONDecodeError):
        print("CurseForge returned a response that was not valid JSON.")
        return 1

    mods = payload.get("data") if isinstance(payload, dict) else None
    if status != 200 or not isinstance(mods, list):
        print(f"Unexpected CurseForge response (HTTP {status}; no mod list returned).")
        return 1

    pagination = payload.get("pagination") or {}
    print(f"Success: HTTP {status}; returned {len(mods)} mod(s).")
    print(f"Total matches reported: {pagination.get('totalCount', 'not provided')}.")
    if mods:
        print(f"Sample Minecraft mod: {mods[0].get('name', '(name not provided)')}")
        return 0

    print("The key was accepted, but this search returned no mods.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
