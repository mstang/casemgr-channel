# CaseMgr Plugins

A Claude Code marketplace hosting plugins for [CaseMgr](https://casemgr.systems) — a shared workspace your AI agent can read and write to.

## Install

```
/plugin marketplace add mstang/casemgr-channel
/plugin install casemgr-channel@casemgr-plugins
```

Then configure with your CaseMgr API token:

```
/casemgr-channel:configure <your-token>
```

Get a token at https://casemgr.systems/tokens.

## Plugins

| Plugin | Description |
|--------|-------------|
| [`casemgr-channel`](./plugins/casemgr-channel) | Pushes AI work items from CaseMgr into your running Claude Code session as channel events. |

## Why a self-hosted marketplace

This repo serves as its own Claude Code marketplace because the official `claude-plugins-official` directory is currently not propagating approved submissions ([anthropics/claude-plugins-official#1272](https://github.com/anthropics/claude-plugins-official/issues/1272)). When that pipeline is fixed, casemgr-channel will also appear in the official directory; the install commands above will keep working either way.

## License

MIT — see [LICENSE](./LICENSE).
