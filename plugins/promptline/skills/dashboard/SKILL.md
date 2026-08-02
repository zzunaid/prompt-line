---
description: Launch the local Promptline dashboard for browsing your Claude Code prompt history
disable-model-invocation: true
---

Start the Promptline local web server as a background process, then tell
the user where to open it. Do not wait for the command to exit - it's a
long-running local HTTP server that only binds to 127.0.0.1.

Run this in the background:

```bash
cd "${CLAUDE_PLUGIN_ROOT}" && python3 server.py
```

Then:

- Wait a second or two, then check it actually started by requesting
  `http://127.0.0.1:8787/api/data` (e.g. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/data`).
- If it returns 200, tell the user Promptline is running at
  `http://127.0.0.1:8787` and to open that URL in their browser.
- If the port is already in use, that almost always means Promptline is
  already running from earlier in this session (or another terminal) - just
  give them the URL, no need to treat it as an error.
- If it fails for another reason, show the actual error output rather than
  guessing at the cause.
