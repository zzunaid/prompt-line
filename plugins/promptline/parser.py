"""Parses Claude Code JSONL session logs into prompt/response entries.

Log format notes (reverse-engineered from real files under ~/.claude/projects/):
- Each line is one JSON object. Relevant "type" values: "user", "assistant".
  Others ("queue-operation", "attachment", "last-prompt", "summary", ...) are
  metadata/bookkeeping and are ignored here.
- A genuine typed prompt is a "user" line whose message.content is a plain
  string. When message.content is a list of {"type": "tool_result", ...}
  blocks instead, that's a synthetic user-turn wrapping a tool result, not
  something the human typed - it's skipped.
- An assistant reply is spread across one or more "assistant" lines, each
  usually holding a single content block (thinking / text / tool_use) of the
  same logical message. We concatenate the "text" blocks that follow a
  prompt, up to the next genuine prompt, to reconstruct what was shown.
- "cwd" on a line gives the project directory. "isSidechain": true marks
  subagent-internal messages, which are excluded from the timeline.
- Each "assistant" line also carries message.model and message.usage
  (input/output/cache token counts). These repeat on every content-block
  line that shares a message id, so they're counted once per unique id and
  collected separately from the prompt/response text, for the summary
  dashboard's token and model stats.
- Typing a slash command (e.g. "/promptline:dashboard") doesn't log as that
  literal text - Claude Code wraps it as
  <command-name>/foo</command-name><command-message>...</command-message>
  <command-args>...</command-args> (tag order varies, command-args is
  omitted when there are no arguments). That's reconstructed back into the
  plain "/foo args" you actually typed rather than shown as raw tags.
- Not every "user" line is something typed, even when it has real text and
  isn't isSidechain: "isMeta": true marks synthetic context Claude Code
  injects into the conversation (e.g. a skill's own instruction body), and
  "promptSource": "system" marks system-fired turns (task-notifications,
  scheduled wakeups) - both are excluded from the timeline. They still act
  as a turn boundary (so the *previous* real prompt's response is closed
  off correctly), the resulting entry is just dropped rather than shown.
"""

import json
import re
from pathlib import Path

_COMMAND_NAME_RE = re.compile(r"<command-name>(.*?)</command-name>", re.DOTALL)
_COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)


def _clean_slash_command(text):
    """Reconstruct the plain "/foo args" a slash command invocation actually
    typed from Claude Code's <command-name>/<command-args> log wrapper, or
    None if `text` isn't one."""
    name_match = _COMMAND_NAME_RE.search(text)
    if not name_match:
        return None
    name = name_match.group(1).strip()
    args_match = _COMMAND_ARGS_RE.search(text)
    args = args_match.group(1).strip() if args_match else ""
    return f"{name} {args}".strip() if args else name


def _extract_prompt_text(content):
    """Return the human-typed text of a user message, or None if this
    "user" line is really just a wrapped tool result / has no text."""
    if isinstance(content, str):
        text = content.strip()
        if not text:
            return None
        if "<command-name>" in text:
            cleaned = _clean_slash_command(text)
            if cleaned:
                return cleaned
        return text
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        joined = "\n".join(p for p in parts if p).strip()
        return joined if joined else None
    return None


def _decode_project_dir(dirname):
    """Fallback: decode ~/.claude/projects/<encoded>/ folder name back into
    a path. Encoding replaces '/' with '-', so this is lossy for directories
    that legitimately contain dashes - only used when no "cwd" was logged."""
    if dirname.startswith("-"):
        return "/" + dirname[1:].replace("-", "/")
    return dirname.replace("-", "/")


def _iter_json_lines(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(obj, dict):
                yield obj


def parse_session_file(path):
    """Parse one .jsonl session file into a dict:
    {sessionId, sessionFile, project, startTime, entries: [...]}
    or None if the file yields no usable prompts.
    """
    path = Path(path)
    objs = list(_iter_json_lines(path))
    if not objs:
        return None

    session_id = None
    project = None
    for obj in objs:
        if not session_id and obj.get("sessionId"):
            session_id = obj["sessionId"]
        if not project and obj.get("cwd"):
            project = obj["cwd"]
        if session_id and project:
            break

    if not session_id:
        session_id = path.stem
    if not project:
        project = _decode_project_dir(path.parent.name)

    entries = []
    current = None
    response_parts = []
    last_message_id = None
    assistant_messages = []
    seen_assistant_ids = set()

    def flush():
        if current is not None and not current.get("synthetic"):
            entries.append(
                {
                    "id": current["uuid"],
                    "sessionId": session_id,
                    "sessionFile": path.name,
                    "project": project,
                    "timestamp": current["timestamp"],
                    "prompt": current["text"],
                    "response": "".join(response_parts).strip(),
                }
            )

    for obj in objs:
        obj_type = obj.get("type")

        if obj_type == "user":
            if obj.get("isSidechain"):
                continue
            message = obj.get("message") or {}
            prompt_text = _extract_prompt_text(message.get("content"))
            if prompt_text is None:
                continue
            flush()
            current = {
                "uuid": obj.get("uuid") or f"{session_id}:{len(entries)}",
                "timestamp": obj.get("timestamp"),
                "synthetic": bool(obj.get("isMeta")) or obj.get("promptSource") == "system",
            }
            current["text"] = prompt_text
            response_parts = []
            last_message_id = None

        elif obj_type == "assistant":
            if obj.get("isSidechain") or current is None:
                continue
            message = obj.get("message") or {}
            message_id = message.get("id")
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "text":
                    continue
                text = block.get("text", "")
                if not text:
                    continue
                if response_parts and message_id != last_message_id:
                    response_parts.append("\n\n")
                response_parts.append(text)
                last_message_id = message_id

            # usage/model are set once per message but repeated on every
            # content-block line sharing that message id - count each
            # message only once.
            if message_id and message_id not in seen_assistant_ids:
                seen_assistant_ids.add(message_id)
                usage = message.get("usage") or {}
                tokens = sum(
                    v
                    for k, v in usage.items()
                    if k
                    in (
                        "input_tokens",
                        "output_tokens",
                        "cache_creation_input_tokens",
                        "cache_read_input_tokens",
                    )
                    and isinstance(v, (int, float))
                )
                assistant_messages.append(
                    {
                        "timestamp": obj.get("timestamp"),
                        "model": message.get("model"),
                        "tokens": int(tokens),
                    }
                )

    flush()

    if not entries:
        return None

    entries.sort(key=lambda e: e["timestamp"] or "")
    assistant_messages.sort(key=lambda m: m["timestamp"] or "")
    return {
        "sessionId": session_id,
        "sessionFile": path.name,
        "project": project,
        "startTime": entries[0]["timestamp"],
        "entries": entries,
        "assistantMessages": assistant_messages,
    }


def find_session_files(projects_root):
    root = Path(projects_root)
    if not root.exists():
        return []
    return sorted(root.rglob("*.jsonl"))
