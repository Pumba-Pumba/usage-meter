# Security

## What usage-meter can reach

usage-meter is a Claude Code mod. It runs in Claude Code's sandboxed hooks environment, which has no file system, network or process access of its own: a mod can reach only the engine calls it names in its source. `claude plugin validate .` lists them. For usage-meter they are:

| Engine call | Why |
| --- | --- |
| `$.clock.now`, `$.clock.every`, `$.clock.after` | The countdown, the animation tick and the keep-warm timer |
| `$.session.usage` | The rate-limit figures Claude Code already has |
| `$.command.register` | The `/meter` command |
| `$.store.get/set/delete/keys` | Its own settings: design, learned cache lifetime, send-guard mode, alerts already shown, picker offered, each session's last reply and keep-warm window |
| `$.session.id` | Keeping each session's figures apart |
| `$.model.fork` | **Only while keep-warm is on** (`/meter keepwarm`): the one-word ping that keeps the cache warm |
| `$.ui.ask`, `$.ui.log` | The send-guard's question before a cold send, and its one-line price note |
| `$.state.get/set` | The design picker's selection and animation frame |
| `$.ui.status`, `$.ui.toast`, `$.ui.notify` | The status line, warnings and the 90% / 100% notification |
| `$.ui.open`, `$.ui.close`, `$.ui.resolve` | The design picker pane |

It also observes four events: each request's token usage and model (`turn.step`), each prompt as it is sent (`prompt.submit`, for the send-guard), rate-limit changes (`session.measure`) and `/compact` (`session.compact`). Of a prompt it reads only whether it starts with `/`; it never reads, keeps or changes message text.

It does **not** call `$.http`, `$.fs`, `$.process`, `$.env` or `$.tool`, and does not read credentials. It calls `$.model` for one thing only: `$.model.fork` with the fixed prompt "Reply with the single word: warm", while keep-warm is on. That fork is a side request: it sees the conversation as Claude Code last sent it, can use no tools, and its reply is never added to your conversation. With keep-warm off (the default), usage-meter makes no model requests at all.

The send-guard never holds a prompt unless you set `/meter guard ask`, and never one it could not ask about (a notification, a scheduled task, an SDK run). If the guard itself fails, the prompt goes through.

## Reporting a vulnerability

Please report security problems privately through GitHub's [private vulnerability reporting](https://github.com/Pumba-Pumba/usage-meter/security/advisories/new), not in a public issue. Include the version (`.claude-plugin/plugin.json`), your Claude Code version and how to reproduce the problem. You'll get a reply as soon as possible.

## Supported versions

Only the latest release on `main` gets fixes.
