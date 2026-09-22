"""Package this checkout for an isolated arena process on the model host.

No deployed source, calendar, database, or settings are modified. Settings
are read with SQLite's read-only mode. The checkout is unpacked into a
temporary directory which disappears after the experiment.
"""
import base64
import gzip
import json
from pathlib import Path


def build_job(root: Path, argv: list[str], implementation: str) -> str:
    modes = {"deployed", "checkout", "checkout-balanced", "checkout-neighborhood", "checkout-balanced-neighborhood"}
    if implementation not in modes:
        raise ValueError("Unknown implementation")
    source = (root / "backend/arena/prompt_eval.py").read_text()
    files = {}
    if implementation != "deployed":
        files = {str(path.relative_to(root)): path.read_text()
                 for path in (root / "backend").rglob("*.py")
                 if "tests" not in path.parts and "__pycache__" not in path.parts}
        fixture = root / "backend/arena/fixture_complex.json"
        files[str(fixture.relative_to(root))] = fixture.read_text()
    packed = base64.b64encode(gzip.compress(json.dumps(files).encode())).decode()
    return f'''import base64, gzip, json, os, pathlib, sqlite3, sys, tempfile
from urllib.parse import quote
sys.argv = {argv!r}
db_path_for_drain = pathlib.Path(os.environ.get("SCHEDULE_DB_PATH", "schedule.db"))
if db_path_for_drain.with_name(".planning-drain").exists():
    raise SystemExit("Deployment in progress; start the arena again after deployment.")
with tempfile.TemporaryDirectory(prefix="shift-arena-") as scratch:
    files = json.loads(gzip.decompress(base64.b64decode({packed!r})))
    for name, content in files.items():
        path = pathlib.Path(scratch) / name
        if not path.resolve().is_relative_to(pathlib.Path(scratch).resolve()):
            raise ValueError("Unsafe archive path")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    if files:
        sys.path.insert(0, scratch)
    import backend.agent_budget as budget
    if "--mock" not in sys.argv:
        db_path = pathlib.Path(os.environ.get("SCHEDULE_DB_PATH", "schedule.db")).resolve()
        connection = sqlite3.connect("file:" + quote(str(db_path)) + "?mode=ro", uri=True)
        try:
            settings = dict(connection.execute("SELECT key, value FROM agent_settings").fetchall())
        finally:
            connection.close()
        budget._read_rows = lambda: dict(settings)
    exec(compile({source!r}, "arena_experiment.py", "exec"), {{"__name__": "__main__"}})
'''


def main():
    import os
    root = Path(__file__).resolve().parents[2]
    implementation = os.environ.get("IMPLEMENTATION", "deployed")
    argv = ["prompt_eval", "--evaluation-ref", os.environ["GITHUB_SHA"]]
    for name in ("start", "days", "timeout", "model", "scenario", "strategy", "variant"):
        if os.environ.get(name.upper()):
            argv.extend(["--" + name, os.environ[name.upper()]])
    if os.environ.get("REASONING"):
        argv.extend(["--reasoning-effort", os.environ["REASONING"]])
    if "balanced" in implementation:
        argv.extend(["--quality-profile", "balanced"])
    if "neighborhood" in implementation:
        argv.append("--neighborhood")
    Path("arena_job.py").write_text(build_job(root, argv, implementation))


if __name__ == "__main__":
    main()
