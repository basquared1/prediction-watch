#!/usr/bin/env python3
"""
Fetch open Kalshi markets and write a normalized snapshot to data/kalshi.json.

Why this runs server-side instead of in the browser:
Kalshi's API only sends CORS headers for Origin: https://kalshi.com. A request
from any other origin gets a 403, so a static page can never fetch it directly.
GitHub Actions has no Origin header, so it gets a normal 200.

Output matches the same "card" schema the client builds for Polymarket, so the
two feeds merge without special-casing downstream.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = "https://api.elections.kalshi.com/trade-api/v2/events"
UA = "prediction-watch/1.0 (+https://github.com/basquared1/prediction-watch)"

MAX_PAGES = 20
PAGE_SIZE = 200
MAX_OUTCOMES = 5
# Sports dominates Kalshi by count and is noise for this dashboard.
SKIP_CATEGORIES = {"Sports"}
# Drop illiquid noise. Kalshi volume is in contracts.
MIN_EVENT_VOLUME = 1000
# Keep the payload small enough to load fast on a phone.
MAX_CARDS = 1500


def get(url, tries=4):
    for attempt in range(tries):
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if attempt == tries - 1:
                raise
            wait = 2 ** attempt
            print(f"  retry {attempt + 1}/{tries - 1} after {e} (sleep {wait}s)", file=sys.stderr)
            time.sleep(wait)


def num(v):
    """Kalshi returns numbers as strings ('0.0300', '99954.93'). None-safe."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def probability(m):
    """Best available probability 0..1: last trade, else bid/ask midpoint."""
    last = num(m.get("last_price_dollars"))
    if last is not None and 0 < last < 1:
        return last
    bid, ask = num(m.get("yes_bid_dollars")), num(m.get("yes_ask_dollars"))
    if bid is not None and ask is not None and (bid or ask):
        return (bid + ask) / 2
    return last


def fetch_events():
    events, cursor, page = [], None, 0
    while page < MAX_PAGES:
        url = f"{API}?with_nested_markets=true&status=open&limit={PAGE_SIZE}"
        if cursor:
            url += f"&cursor={cursor}"
        data = get(url)
        batch = data.get("events") or []
        events.extend(batch)
        cursor = data.get("cursor")
        page += 1
        print(f"  page {page}: +{len(batch)} events (total {len(events)})", file=sys.stderr)
        if not cursor or not batch:
            break
        time.sleep(0.25)  # be polite
    return events


def build_card(ev):
    category = ev.get("category") or "Other"
    if category in SKIP_CATEGORIES:
        return None

    markets = [m for m in (ev.get("markets") or []) if m.get("status") in ("active", "initialized")]
    if not markets:
        return None

    volume = sum(num(m.get("volume_fp")) or 0 for m in markets)
    volume24h = sum(num(m.get("volume_24h_fp")) or 0 for m in markets)
    if volume < MIN_EVENT_VOLUME:
        return None

    outcomes = []
    if len(markets) == 1:
        m = markets[0]
        p = probability(m)
        if p is None:
            return None
        outcomes.append({"label": "Yes", "prob": p})
        title = m.get("title") or ev.get("title") or ""
    else:
        for m in markets:
            p = probability(m)
            if p is None:
                continue
            label = m.get("yes_sub_title") or m.get("title") or m.get("ticker") or "?"
            outcomes.append({"label": label, "prob": p})
        outcomes.sort(key=lambda o: o["prob"], reverse=True)
        title = ev.get("title") or ""

    if not outcomes:
        return None

    close = min(
        (m.get("close_time") for m in markets if m.get("close_time")), default=None
    )
    series = (ev.get("series_ticker") or "").lower()

    return {
        "id": "k:" + (ev.get("event_ticker") or series),
        "source": "kalshi",
        "title": title.strip(),
        "subtitle": (ev.get("sub_title") or "").strip(),
        "category": category,
        "tags": [category],
        "outcomes": outcomes[:MAX_OUTCOMES],
        "outcomeCount": len(outcomes),
        "volume": round(volume),
        "volume24h": round(volume24h),
        "close": close,
        "url": f"https://kalshi.com/markets/{series}" if series else "https://kalshi.com/markets",
    }


def main():
    print("Fetching Kalshi events...", file=sys.stderr)
    events = fetch_events()

    cards = [c for c in (build_card(e) for e in events) if c]
    cards.sort(key=lambda c: c["volume"], reverse=True)
    cards = cards[:MAX_CARDS]

    out = {
        "source": "kalshi",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "eventsScanned": len(events),
        "count": len(cards),
        "cards": cards,
    }

    path = os.path.join(os.path.dirname(__file__), "..", "data", "kalshi.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")

    print(f"Wrote {len(cards)} cards from {len(events)} events -> data/kalshi.json", file=sys.stderr)

    if not cards:
        print("ERROR: no cards produced; refusing to publish an empty feed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
