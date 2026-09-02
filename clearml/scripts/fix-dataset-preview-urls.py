#!/usr/bin/env python3
"""Fix dataset preview URLs in Elasticsearch after project rename."""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ES_URL = os.environ.get("CLEARML_ELASTIC_URL", "http://clearml-elastic:9200")
INDEX = "events-training_debug_image-*"

REPLACEMENTS = [
    ("Intellivix-Datasets", "Dataset"),
    ("/.datasets/detector-dataset/", "/.datasets/Detector/"),
    ("/.datasets/vlm-dataset/", "/.datasets/VLM/"),
]


def es_request(path: str, body: dict | None = None) -> dict:
    data = None
    headers = {"Content-Type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{ES_URL.rstrip('/')}/{path.lstrip('/')}", data=data, headers=headers, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    count_body = {
        "query": {
            "bool": {
                "should": [
                    {"wildcard": {"url": "*Intellivix-Datasets*"}},
                    {"wildcard": {"url": "*detector-dataset/*"}},
                    {"wildcard": {"url": "*vlm-dataset/*"}},
                ],
                "minimum_should_match": 1,
            }
        }
    }
    total = es_request(f"{INDEX}/_count", count_body)["count"]
    print(f"Events to scan: {total}")
    if not total:
        return 0

    updated = 0
    scroll = es_request(f"{INDEX}/_search?scroll=2m", {
        "size": 100,
        "query": count_body["query"],
        "_source": ["url"],
    })
    scroll_id = scroll["_scroll_id"]

    while True:
        hits = scroll["hits"]["hits"]
        if not hits:
            break

        for hit in hits:
            url = (hit.get("_source") or {}).get("url") or ""
            new_url = url
            for old, new in REPLACEMENTS:
                new_url = new_url.replace(old, new)
            if new_url == url:
                continue
            es_request(f"{INDEX}/_update/{hit['_id']}", {"doc": {"url": new_url}})
            updated += 1
            print(f"UPDATE {hit['_id']}\n  {url}\n  -> {new_url}")

        scroll = es_request("_search/scroll", {"scroll": "2m", "scroll_id": scroll_id})
        scroll_id = scroll["_scroll_id"]

    try:
        es_request("_search/scroll", {"scroll_id": scroll_id, "scroll": "0s"})
    except urllib.error.HTTPError:
        pass

    print(f"Updated {updated} event(s)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.URLError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)
