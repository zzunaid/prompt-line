# Implementation notes

Deeper detail than the main README needs — for anyone extending or auditing
this code.

## How it works

Claude Code writes one JSONL file per session under `~/.claude/projects/`.
Promptline scans that tree, keeps a parsed copy in memory, and serves a web
UI over it.

**Stack:** Python 3, standard library only — `http.server`, `threading`,
`json`, `pathlib`. No `pip install`, no npm, no build step. The frontend is
plain HTML/CSS/JS with no CDN references; everything is served from this
repo. Live updates use Server-Sent Events (`EventSource`), which needs zero
extra code on either end, instead of WebSockets, which Python's stdlib
doesn't provide a server for.

**The one tradeoff:** there's no OS-level file watching (no `inotify`) in
the standard library, so a background thread polls file modification times
every ~2 seconds. When a file changes, the server reparses just that file
and tells connected browsers "something changed" over SSE; the browser then
re-fetches the full dataset. That means new prompts can take up to ~2
seconds to appear, and each refresh re-sends the whole dataset rather than
just the diff — both fine tradeoffs for a personal, local tool, in exchange
for a watcher simple enough to trust and zero dependencies to install.

## Notes on the log format

Claude Code's JSONL schema isn't officially documented, so this was built
by reading real log files directly:

- Genuine typed prompts are `"type": "user"` lines whose `message.content`
  is a plain string. Lines where `message.content` is a list of
  `tool_result` blocks are the tool-output echoes the CLI also logs as
  "user" turns — those are filtered out, since they're not something you
  typed.
- Claude's replies are spread across multiple `"type": "assistant"` lines
  (thinking / text / tool-use blocks are logged separately); Promptline
  concatenates the `text` blocks between one prompt and the next to
  reconstruct the reply shown to you.
- The project directory comes from the `cwd` field logged on each line, not
  from decoding the `~/.claude/projects/<encoded-path>/` folder name (that
  encoding is ambiguous for paths containing dashes).
- Subagent-internal messages (`"isSidechain": true`) are excluded — this is
  a timeline of what *you* typed, not what background agents said to each
  other.
- Any line that fails to parse as JSON, or has an unexpected shape, is
  skipped rather than crashing the parse.
- Token/model stats come from `message.model` and `message.usage` on
  `"assistant"` lines. Both repeat on every content-block line that shares
  a message id (thinking/text/tool-use are logged as separate lines of the
  same message), so each is counted once per unique id. "Total tokens" sums
  input, output, cache-creation, and cache-read tokens across those
  messages — it's cumulative usage, not distinct content, so cache-heavy
  sessions can look large.
- Typing a slash command (e.g. `/promptline:dashboard`) doesn't log as that
  literal text - Claude Code wraps it in `<command-name>`/`<command-args>`
  tags, which get reconstructed back into the plain command you typed.
- Not everything logged as a `"user"` turn was actually typed: synthetic
  context Claude Code injects into the conversation (`"isMeta": true`,
  e.g. a skill's own instruction body) and system-fired turns
  (`"promptSource": "system"` - task-notifications, scheduled wakeups) are
  excluded from the timeline the same way sidechain messages are.

## Plugin dev loop

Installing the Claude Code plugin copies its code into
`~/.claude/plugins/cache/promptline/promptline/<version>/` - a separate
snapshot, not a live link back to a local clone. Editing files in the repo
won't affect what `/promptline:dashboard` runs until the version in
`plugins/promptline/.claude-plugin/plugin.json` is bumped and the plugin is
reinstalled. While iterating, just run `python3 server.py` directly instead
- both point at the same `~/.claude/projects/` by default, so either one
shows the same data; it's only the *code* that's a separate copy.
