# Promptline

A local, read-only visual timeline of everything you've typed into Claude
Code, reconstructed from your own session logs so you can recover context
you've forgotten across projects and sessions.

## How it works

Claude Code writes one JSONL file per session under `~/.claude/projects/`.
Promptline scans that tree, keeps a parsed copy in memory, and serves a web
UI over it. It watches for changes (new prompts as you work) and pushes live
updates to any open browser tab.

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

## Privacy / safety

- Binds only to `127.0.0.1` — never reachable from your network.
- Makes no outbound network calls of any kind.
- Only *reads* files under `~/.claude/projects/`; never writes, moves, or
  deletes anything there.
- Nothing is sent anywhere: everything happens in your browser and this one
  local process.

## Running it

Requires Python 3.7+ (uses only the standard library — nothing to install).

```bash
python3 server.py
```

Then open http://127.0.0.1:8787 in your browser.

By default it watches `~/.claude/projects`. Override with:

```bash
python3 server.py --dir /path/to/other/projects --port 9000
```

By default it only loads the **3 most recent sessions per project**, so a
project with months of history doesn't flood the UI (or memory) with old
sessions. Override with:

```bash
python3 server.py --max-sessions-per-project 10
```

This only limits what's loaded into the app — nothing on disk is touched,
and a session that starts getting new prompts again re-enters the window on
the next poll.

Stop it with `Ctrl+C`.

## Using it

- **Summary** is the default view: a dashboard with prompt/session/project
  counts, a 14-day activity chart, and your top projects by prompt volume
  (click one to jump into Timeline filtered to it).
- **Timeline / Project / Session** toggle switches how prompts are grouped:
  - **Timeline** — every prompt across every project, one chronological feed.
  - **Project** — grouped by the working directory Claude Code was run in;
    each project is collapsible, and shows how many of its sessions are
    currently loaded if some were capped.
  - **Session** — grouped by session (one `.jsonl` file), showing when the
    session started and how many prompts it contains.
- **Newest / Oldest** toggles sort order within whichever of those three
  views is active.
- The **search box** filters by keyword across both your prompts and
  Claude's responses; the **project dropdown** narrows to one project.
- Each card shows your prompt ("You") and Claude's text response ("Claude")
  to it; both truncate to a few lines by default with a "Show more" toggle,
  so scanning a long history doesn't mean scrolling past walls of text.
- A green dot in the header means the live-update connection is active; it
  greys out if the connection drops (e.g. you closed your laptop lid).

## Files

```
server.py        stdlib HTTP server: /api/data, /api/stream (SSE), static files
parser.py        JSONL -> prompt/response entries
static/
  index.html     page shell
  style.css      styling
  app.js         view/sort/search/filter logic, SSE client
```

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
