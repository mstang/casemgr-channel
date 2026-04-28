---
name: configure
description: Set up the CaseMgr channel — save the API token and verify it works. Use when the user pastes a CaseMgr token, asks to configure casemgr-channel, asks "how do I set this up," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(curl *)
---

# /casemgr-channel:configure — CaseMgr Channel Setup

Writes a CaseMgr API token to `~/.claude/channels/casemgr/.env` so the channel server can authenticate when polling for AI work items.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read the env file and tell the user where they stand:

1. **Token** — check `~/.claude/channels/casemgr/.env` for `CASEMGR_TOKEN`. Show set/not-set; if set, show the first 8 chars masked (e.g. `abc12345...`).
2. **URL** — show `CASEMGR_URL` (default if unset: `https://casemgr.systems`).
3. **Last log line** — if `~/.claude/channels/casemgr-channel.log` exists, show the last line so the user knows whether the channel is connected.

End with a concrete next step:
- No token → *"Get a token at https://casemgr.systems/tokens and run `/casemgr-channel:configure <token>`"*
- Token set → *"Restart Claude Code with `claude --channels plugin:casemgr-channel@<marketplace>` to activate the channel."*

### One arg — token

The user passed a token. Validate, then save:

1. **Validate the token** by hitting an authenticated CaseMgr endpoint. The
   channel server itself uses `/api/ai/events` (SSE), but for a one-shot
   validation curl `/api/extension/cases` is friendlier — it returns JSON
   with a 200 when the token is good and 401 when it isn't.
   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer <token>" \
     https://casemgr.systems/api/extension/cases
   ```
   Expected: `200`. `401` → tell the user the token doesn't work and stop.
   Anything else (e.g. `5xx`, network error) → warn the user but proceed
   to save the token anyway, since the endpoint may be temporarily
   degraded while the token itself is fine.

2. **Make sure the directory exists:**
   ```bash
   mkdir -p ~/.claude/channels/casemgr
   ```

3. **Write the env file** (overwrites cleanly):
   ```
   CASEMGR_TOKEN=<token>
   ```
   Path: `~/.claude/channels/casemgr/.env`

4. **Confirm** to the user:
   - "Token saved to `~/.claude/channels/casemgr/.env`."
   - "Restart Claude Code with `claude --channels plugin:casemgr-channel@<marketplace>` to start receiving AI work items."

### Two args — token + url (self-hosted)

For users running CaseMgr on a custom host (e.g. `https://casemgr.example.com`):

1. Validate against `<url>/api/extension/cases` instead of `https://casemgr.systems/api/extension/cases`.
2. Write both `CASEMGR_TOKEN=<token>` and `CASEMGR_URL=<url>` to the env file.
3. Confirm with the same restart instruction.

---

## Notes

- Token is stored unencrypted on disk by design — it's an API token (not a password) and the file is in the user's home directory under `~/.claude/`. Same trust boundary as a `.netrc` or `~/.aws/credentials`.
- The channel server reads `CASEMGR_TOKEN`, `CASEMGR_URL`, and `POLL_INTERVAL_MS` from this file at startup. If the user wants a custom poll interval, they can edit the file by hand or use the shell environment (which takes precedence).
- If the user already has the token stored elsewhere (e.g. `~/.config/casemgr/token` from the `wa` CLI), tell them about it but don't read it automatically — they should make an explicit copy here, since this token will be used by Claude on their behalf.
