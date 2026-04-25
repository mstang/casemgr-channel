# casemgr-channel

A [Claude Code channel](https://code.claude.com/docs/en/channels) that pushes AI work items from [CaseMgr](https://casemgr.systems) into your running Claude Code session.

When a CMMN workflow in CaseMgr produces an AI work item, the channel server forwards it as a `<channel source="casemgr-channel">` event so Claude can claim, execute, and complete it without any human prompt.

## What is CaseMgr?

A shared, persistent workspace for you and your AI agent — 184 MCP tools across a graph of notes, tasks, files, calendar, and agent presence. Your agent creates notes when it finds things, plans tasks when there's work to do, and marks them done as it finishes. You review, edit, and add your own. Sessions resume exactly where they left off.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A [CaseMgr API token](https://casemgr.systems/tokens)
- Claude Code v2.1.80+ (channels are research preview)

## Quick Setup

These are Claude Code commands — start a session with `claude` first.

**1. Install the plugin.**

```
/plugin install casemgr-channel@claude-plugins-official
/reload-plugins
```

**2. Configure your token.**

Get a token at https://casemgr.systems/tokens, then:

```
/casemgr-channel:configure <token>
```

This writes `CASEMGR_TOKEN=...` to `~/.claude/channels/casemgr/.env`. The shell environment takes precedence if you'd rather set `CASEMGR_TOKEN` there.

**3. Relaunch with the channel flag.**

```bash
claude --channels plugin:casemgr-channel@claude-plugins-official
```

The channel server starts in the background and connects to CaseMgr. From now on, AI work items pending in your CaseMgr account arrive in this session as channel events that Claude is expected to act on (claim → execute → complete).

## How it works

The plugin spawns `channel.ts` as an MCP/channel server. It does two things:

1. **Connects to CaseMgr** as an MCP client over Streamable HTTP, authenticated with your token. It subscribes to the `/api/ai/events` SSE stream for real-time events, with periodic polling as a fallback.
2. **Pushes work items into Claude Code** as `<channel source="casemgr-channel">` events. Each event includes the work item ID, the case it belongs to, and the prompt — enough for Claude to call `ai-claim_work_item` → execute → `ai-complete_work_item`.

When Claude completes the work item via the existing `casemgr` MCP tools, the result lands back in CaseMgr and the workflow moves on.

## Self-hosting / custom CaseMgr URL

If you're running CaseMgr on a custom host:

```
/casemgr-channel:configure <token> https://casemgr.example.com
```

Or set both `CASEMGR_TOKEN` and `CASEMGR_URL` in your shell environment.

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `CASEMGR_TOKEN` | Yes | — | Bearer token from `casemgr.systems/tokens` |
| `CASEMGR_URL` | No | `https://casemgr.systems` | Base URL for self-hosted instances |
| `POLL_INTERVAL_MS` | No | `30000` | SSE-fallback poll cadence |

Edit `~/.claude/channels/casemgr/.env` directly to tune the poll interval; the shell environment takes precedence over the file.

## Logs

The channel server logs to `~/.claude/channels/casemgr-channel.log` (best-effort) and stderr. If the channel is silent for a long stretch, check the log for connection errors.

## License

MIT — see [LICENSE](./LICENSE).
