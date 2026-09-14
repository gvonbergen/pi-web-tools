import json
import sys

mode = json.load(sys.stdin)["url"]
html = "界" * (700 if mode == "html-overflow" else 600)
payload = {"ok": True, "html": html}
if mode == "transport-overflow":
    payload["title"] = "A" * 80000
json.dump(payload, sys.stdout, ensure_ascii=mode != "utf8")
