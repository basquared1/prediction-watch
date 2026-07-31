# Prediction Watch

One read-only feed of prediction markets from **Kalshi** and **Polymarket**, filtered to the
topics I actually follow. No betting, wallet, deposit, or trade functionality — market data only.

**Live:** https://basquared1.github.io/prediction-watch/

## Topics

The "For you" feed covers: politics · financial markets · economy & the Fed · AI & tech ·
media & streaming · entertainment industry · law & regulation.

Sports and esports are deliberately filtered out of every topic (still reachable under "All"
and via search).

## How the data gets here

Two different paths, for one specific reason:

| Source | Path | Freshness |
|---|---|---|
| **Polymarket** | fetched live in the browser | real time |
| **Kalshi** | GitHub Action → `data/kalshi.json` | every ~30 min |

Kalshi's API only returns CORS headers for `Origin: https://kalshi.com`. A request from any
other origin gets a `403`, so a static page **cannot** fetch Kalshi directly, no matter where
it's hosted. GitHub Actions sends no `Origin` header, so it gets a normal `200` — it fetches
the data server-side and commits a snapshot the page reads same-origin.

Polymarket sends `access-control-allow-origin: *`, so it's fetched straight from the browser.

## Layout

```
index.html                     markup
styles.css                     dark, mobile-first
app.js                         fetch, topic classifier, render
scripts/fetch_kalshi.py        server-side Kalshi fetch -> data/kalshi.json
.github/workflows/refresh.yml  cron, every 30 min
data/kalshi.json               generated snapshot (committed)
```

## Local development

```bash
python3 scripts/fetch_kalshi.py   # refresh the Kalshi snapshot
python3 -m http.server 8765       # then open http://localhost:8765
```

## Notes

- Volume for Kalshi is in contracts; Polymarket is in dollars. Similar magnitude, not identical units.
- Polymarket leaves a stale `endDate` on some still-trading markets, so past close dates are hidden
  rather than labelled "closed".
- Favorites are stored in `localStorage`, so they're per-device.
