"""The analyzer imports psycopg2 at load; the tests run it without a database driver or a database."""
import sys
import types

extras = types.ModuleType("psycopg2.extras")
extras.RealDictCursor = dict
psycopg2 = types.ModuleType("psycopg2")
psycopg2.extras = extras
psycopg2.connect = lambda *a, **k: None
sys.modules["psycopg2"] = psycopg2
sys.modules["psycopg2.extras"] = extras
