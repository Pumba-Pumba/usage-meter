# Changelog

## 1.0.1 — 2026-11-07

- Fix: resuming a session no longer resets the cache countdown. The last reply's time and size are saved per session (the last 30), so a resumed session shows the cache still warm with the right time left, or cold with the re-cache cost, instead of nothing and then a fresh hour.
- Fix: the first draw after a session starts always reaches the status line, so a stale line can't linger.

## 1.0.0 — 2026-11-07

First public release.

- One status line with the prompt-cache countdown and the 5-hour and weekly limits.
- Cache lifetime (5m or 1h) learned from the API's behavior, or set with `/meter ttl`.
- Unexpected re-cache detection; expiry and `/compact` are not counted.
- Pace forecast that warns only when 100% would come before the reset.
- Alerts once per window at 75%, 90% and 100%, and once before the cache goes cold.
- Ten designs: aurora, pulse, glass, flux and prism (animated); classic, bars, icons, minimal and blueprint (still).
- A design picker on first run and with `/meter designs`.
- No credentials, network, files or processes.
