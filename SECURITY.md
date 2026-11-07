# Security

## What usage-meter can reach

usage-meter is a Claude Code mod. It runs in Claude Code's sandboxed hooks environment, which has no file system, network or process access of its own: a mod can reach only the engine calls it names in its source. `claude plugin validate .` lists them. For usage-meter they are:

| Engine call | Why |
| --- | --- |
| `$.clock.now`, `$.clock.every` | The countdown and the animation tick |
| `$.session.usage` | The rate-limit figures Claude Code already has |
| `$.command.register` | The `/meter` command |
| `$.store.get/set/delete` | Its own settings: design, learned cache lifetime, alerts already shown, picker offered |
| `$.state.get/set` | The design picker's selection and animation frame |
| `$.ui.status`, `$.ui.toast`, `$.ui.notify` | The status line, warnings and the 90% / 100% notification |
| `$.ui.open`, `$.ui.close`, `$.ui.resolve` | The design picker pane |

It also observes three events: each reply's token usage (`turn.step`), rate-limit changes (`session.measure`) and `/compact` (`session.compact`). It reads token counts only, never message text.

It does **not** call `$.http`, `$.fs`, `$.process`, `$.env`, `$.model` or `$.tool`, does not read credentials, and does not change your conversation.

## Reporting a vulnerability

Please report security problems privately through GitHub's [private vulnerability reporting](https://github.com/Pumba-Pumba/usage-meter/security/advisories/new), not in a public issue. Include the version (`.claude-plugin/plugin.json`), your Claude Code version and how to reproduce the problem. You'll get a reply as soon as possible.

## Supported versions

Only the latest release on `main` gets fixes.
