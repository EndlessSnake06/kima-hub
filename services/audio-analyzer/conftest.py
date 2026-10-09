"""The analyzer imports psycopg2 at load; the tests run it without a database driver or a database."""
import os
import sys
import types

extras = types.ModuleType("psycopg2.extras")
extras.RealDictCursor = dict
psycopg2 = types.ModuleType("psycopg2")
psycopg2.extras = extras
psycopg2.connect = lambda *a, **k: None
sys.modules["psycopg2"] = psycopg2
sys.modules["psycopg2.extras"] = extras

# gpu_switch ships beside the analyzer in every image; in the repository it lives with the GPU wrapper.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "audio-analyzer-clap"))
