#!/usr/bin/env python3
"""Promptline server: parses ~/.claude/projects/**/*.jsonl and serves a
local, read-only web UI over your Claude Code prompt history.

Stdlib only. Binds to 127.0.0.1 - never listens on any external interface,
makes no outbound network calls, and never writes to ~/.claude.
"""

import argparse
import json
import mimetypes
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from parser import find_session_files, parse_session_file

STATIC_DIR = Path(__file__).parent / "static"
POLL_INTERVAL_SECONDS = 2.0
DEFAULT_MAX_SESSIONS_PER_PROJECT = 3


class Store:
    """In-memory cache of parsed sessions, kept fresh by a poller thread."""

    def __init__(self, projects_root, max_sessions_per_project=DEFAULT_MAX_SESSIONS_PER_PROJECT):
        self.projects_root = Path(projects_root)
        self.max_sessions_per_project = max_sessions_per_project
        self._lock = threading.Lock()
        self._sessions = {}  # path (str) -> parsed session dict
        self._mtimes = {}  # path (str) -> mtime float
        self._subscribers = []  # list of queue.Queue, one per SSE client

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _notify(self):
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait("refresh")
            except queue.Full:
                pass

    def snapshot(self):
        with self._lock:
            sessions = list(self._sessions.values())

        by_project = {}
        for s in sessions:
            by_project.setdefault(s["project"], []).append(s)

        # Cap to the N most recently started sessions per project, computed
        # fresh on every call so a session that starts getting new prompts
        # again can re-enter the window. Full history stays on disk; this
        # only limits how much gets held in the API response / rendered.
        kept_sessions = []
        project_session_counts = {}
        for project, group in by_project.items():
            group.sort(key=lambda s: s["startTime"] or "", reverse=True)
            kept = group[: self.max_sessions_per_project]
            kept_sessions.extend(kept)
            project_session_counts[project] = {"shown": len(kept), "total": len(group)}

        entries = []
        assistant_messages = []
        projects = set()
        for s in kept_sessions:
            projects.add(s["project"])
            entries.extend(s["entries"])
            for m in s.get("assistantMessages", []):
                assistant_messages.append(
                    {
                        "sessionId": s["sessionId"],
                        "project": s["project"],
                        "timestamp": m["timestamp"],
                        "model": m["model"],
                        "tokens": m["tokens"],
                    }
                )

        sessions_meta = [
            {
                "sessionId": s["sessionId"],
                "sessionFile": s["sessionFile"],
                "project": s["project"],
                "startTime": s["startTime"],
                "promptCount": len(s["entries"]),
            }
            for s in kept_sessions
        ]
        return {
            "entries": entries,
            "assistantMessages": assistant_messages,
            "projects": sorted(projects),
            "sessions": sessions_meta,
            "projectSessionCounts": project_session_counts,
            "maxSessionsPerProject": self.max_sessions_per_project,
        }

    def poll_once(self):
        changed = False
        current_files = find_session_files(self.projects_root)
        current_paths = {str(p) for p in current_files}

        with self._lock:
            known_paths = set(self._mtimes.keys())

        # Drop sessions for files that were removed.
        for stale in known_paths - current_paths:
            with self._lock:
                self._mtimes.pop(stale, None)
                self._sessions.pop(stale, None)
            changed = True

        for path in current_files:
            key = str(path)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            with self._lock:
                known_mtime = self._mtimes.get(key)
            if known_mtime is not None and known_mtime == mtime:
                continue  # unchanged since last poll

            try:
                parsed = parse_session_file(path)
            except Exception:
                # Never let one malformed file take down the watcher.
                parsed = None

            with self._lock:
                self._mtimes[key] = mtime
                if parsed is None:
                    self._sessions.pop(key, None)
                else:
                    self._sessions[key] = parsed
            changed = True

        if changed:
            self._notify()
        return changed

    def watch_forever(self, stop_event):
        while not stop_event.is_set():
            try:
                self.poll_once()
            except Exception:
                pass
            stop_event.wait(POLL_INTERVAL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "Promptline/1.0"

    def log_message(self, fmt, *args):
        pass  # keep stdout quiet; nothing sensitive should hit terminal noise either way

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path):
        file_path = (STATIC_DIR / rel_path).resolve()
        if STATIC_DIR.resolve() not in file_path.parents and file_path != STATIC_DIR.resolve():
            self.send_error(403)
            return
        if not file_path.is_file():
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(str(file_path))
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_stream(self):
        store = self.server.store
        q = store.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                try:
                    q.get(timeout=15)
                    self.wfile.write(b"event: refresh\ndata: {}\n\n")
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            store.unsubscribe(q)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/data":
            self._send_json(self.server.store.snapshot())
        elif path == "/api/stream":
            self._handle_stream()
        elif path == "/" or path == "":
            self._send_static("index.html")
        else:
            self._send_static(path.lstrip("/"))


def main():
    parser = argparse.ArgumentParser(description="Promptline local server")
    parser.add_argument(
        "--dir",
        default=os.environ.get("PROMPTLINE_PROJECTS_DIR", os.path.expanduser("~/.claude/projects")),
        help="Root directory to scan for *.jsonl session logs (default: ~/.claude/projects)",
    )
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument(
        "--max-sessions-per-project",
        type=int,
        default=DEFAULT_MAX_SESSIONS_PER_PROJECT,
        help="Only show the N most recently started sessions per project (default: 3). "
        "Nothing on disk is touched; this only limits what's loaded into the UI.",
    )
    args = parser.parse_args()

    store = Store(args.dir, max_sessions_per_project=args.max_sessions_per_project)
    store.poll_once()  # initial synchronous load so the first request has data

    stop_event = threading.Event()
    watcher = threading.Thread(target=store.watch_forever, args=(stop_event,), daemon=True)
    watcher.start()

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.store = store

    snap = store.snapshot()
    print(f"Promptline serving http://127.0.0.1:{args.port}")
    print(f"Watching: {store.projects_root}")
    print(f"Loaded {len(snap['entries'])} prompts across {len(snap['sessions'])} sessions, "
          f"{len(snap['projects'])} projects (showing up to {args.max_sessions_per_project} "
          f"most recent sessions per project).")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        httpd.shutdown()


if __name__ == "__main__":
    main()
