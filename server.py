#!/usr/bin/env python3
"""Thin entry point.

The real implementation lives in plugins/promptline/, so this repo can
double as its own Claude Code plugin marketplace source (plugins are
installed by copying just their own subdirectory, so the code has to live
there). This file exists so `python3 server.py` from the repo root keeps
working exactly as before - it just delegates to the real script.
"""
import runpy
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent / "plugins" / "promptline"
sys.path.insert(0, str(PLUGIN_DIR))
runpy.run_path(str(PLUGIN_DIR / "server.py"), run_name="__main__")
