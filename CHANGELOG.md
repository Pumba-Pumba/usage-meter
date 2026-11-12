# Changelog

## 1.1.0 — 2026-11-12

Ideas borrowed from [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT), fitted to usage-meter's learned cache lifetime.

- Prices: a cold cache now shows what re-caching costs at list price (`~200k to re-cache ~$0.80`), on every design. `/meter` adds the warm cost beside it and the dollars lost to unexpected re-caches. A cache write is priced at the lifetime it really has (1.25x base input for 5 minutes, 2x for 1 hour), not always at the 1-hour rate.
- Send-guard: a message about to go into a cold cache of 50k tokens or more shows its price in one line and goes through (`warn`, the default). `/meter guard ask` asks first, with "Send anyway" and "Don't send"; `/meter guard ask $2` asks only from $2 up; `/meter guard off` turns it off. Prompts nobody could send again (notifications, scheduled tasks, SDK runs) are never held.
- Keep-warm, off unless you turn it on: `/meter keepwarm 3h` (or `90m`, up to `24h`) sends a one-word side request to Claude shortly before the cache would go cold (10 minutes before on a 1-hour cache, 1 minute before on a 5-minute one), so the cache is read instead of re-written. Each ping is checked: one that finds the cache already gone stops keep-warm and says so. A busy API is retried up to three times. `/meter keepwarm off` stops it; `/meter` shows the pings sent and what they cost.
- Fix: the countdown now starts when a request is sent, not when its reply ends, so a reply that takes minutes no longer makes the countdown too generous by that long.

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
