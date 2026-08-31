#!/usr/bin/env python3
"""pi-web-tools Camoufox bridge.

Thin subprocess bridge: reads a JSON request from stdin
    {"url": "...", "timeoutMs": 90000}
and writes a JSON reply to stdout:
    {"ok": true, "html": "...", "finalUrl": "...", "title": "..."}
or  {"ok": false, "error": "..."}

Requires: python >= 3.10, `pip install "camoufox[geoip]"` and `camoufox fetch`.
The bridge runs one fresh, isolated browser context per invocation (no shared
cookies/localStorage across sites) and always closes the browser on exit, so
cancellation (SIGKILL of this process) leaves no orphan browser processes
beyond what the OS reaps from the dead parent tree.
"""

from __future__ import annotations

import asyncio
import json
import sys


async def _render(url: str, timeout_ms: int) -> dict:
    from camoufox.async_api import AsyncCamoufox  # type: ignore

    async with AsyncCamoufox(headless=True) as browser:
        context = await browser.new_context()  # fresh, isolated context per call
        try:
            page = await context.new_page()
            await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            # Give client-side frameworks a brief settle window.
            await page.wait_for_timeout(1500)
            html = await page.content()
            final_url = page.url
            title = await page.title()
            return {"ok": True, "html": html, "finalUrl": final_url, "title": title}
        finally:
            await context.close()


def main() -> None:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        url = request.get("url")
        timeout_ms = int(request.get("timeoutMs", 90_000))
        if not url:
            raise ValueError("missing url")
        result = asyncio.run(_render(url, timeout_ms))
        json.dump(result, sys.stdout)
    except Exception as exc:  # noqa: BLE001 - bridge must always emit JSON
        json.dump({"ok": False, "error": str(exc)[:500]}, sys.stdout)
        sys.exit(0)


if __name__ == "__main__":
    main()
