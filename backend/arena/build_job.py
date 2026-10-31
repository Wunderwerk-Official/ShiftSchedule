"""Package this checkout for an isolated arena process on the model host.

No deployed source, calendar, database, or settings are modified. Settings
are read with SQLite's read-only mode. The checkout is unpacked into a
temporary directory which disappears after the experiment; a pid file in the
container's temp directory exists only while the run lasts (cancel step).
"""
import base64
import gzip
import json
import re
from pathlib import Path


def pid_file_name(run_id: str) -> str:
    """Per-run pid file name inside the container's temp directory."""
    safe = re.sub(r"[^0-9A-Za-z_-]", "", run_id) or "local"
    return f"shift-arena-{safe}.pid"


def build_job(root: Path, argv: list[str], implementation: str, run_id: str = "local") -> str:
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
    return f'''import base64, gzip, json, os, pathlib, signal, sqlite3, sys, tempfile
from urllib.parse import quote
sys.argv = {argv!r}
# SIGTERM (cancel step, container timeout) ends the run through SystemExit,
# so the scratch checkout and the pid file are removed below.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
db_path_for_drain = pathlib.Path(os.environ.get("SCHEDULE_DB_PATH", "schedule.db"))
if db_path_for_drain.with_name(".planning-drain").exists():
    raise SystemExit("Deployment in progress; start the arena again after deployment.")
# A cancelled job drops ssh, which does not end this non-TTY exec: the
# workflow's cancel step stops the process recorded here (stop_job).
pid_file = pathlib.Path(tempfile.gettempdir()) / {pid_file_name(run_id)!r}
pid_file.write_text(str(os.getpid()))
try:
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
finally:
    pid_file.unlink(missing_ok=True)
'''


def stop_job(run_id: str = "local") -> str:
    """Script for the workflow's cancel step: stops this run's arena process
    in the container. The pid file can outlive a killed process, so only a
    process that still is a stdin python job is stopped."""
    return f'''import os, pathlib, signal, tempfile
pid_file = pathlib.Path(tempfile.gettempdir()) / {pid_file_name(run_id)!r}
try:
    pid = int(pid_file.read_text())
except (FileNotFoundError, ValueError):
    pid = None
try:
    arguments = pathlib.Path(f"/proc/{{pid}}/cmdline").read_bytes().split(b"\\0") if pid else None
except (FileNotFoundError, ProcessLookupError):
    arguments = None
if arguments is None:
    pid_file.unlink(missing_ok=True)
    print("No arena process of this run is running.")
else:
    if (len(arguments) > 1 and arguments[1] == b"-"
            and os.path.basename(os.fsdecode(arguments[0])).startswith("python")):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            print("The arena process had already ended.")
        else:
            print(f"Stopped arena process {{pid}}.")
        pid_file.unlink(missing_ok=True)
    else:
        print("The recorded process is no longer the arena job.")
'''


def main():
    import os
    root = Path(__file__).resolve().parents[2]
    implementation = os.environ.get("IMPLEMENTATION", "deployed")
    argv = ["prompt_eval", "--evaluation-ref", os.environ["GITHUB_SHA"]]
    for name in ("start", "days", "timeout", "model", "scenario", "strategy", "variant", "provider"):
        if os.environ.get(name.upper()):
            argv.extend(["--" + name, os.environ[name.upper()]])
    reasoning = os.environ.get("REASONING")
    if reasoning:
        # xhigh/max exist as Claude effort only; prompt_eval maps
        # low/medium/high to the Claude effort when the provider is Anthropic.
        flag = "--effort" if reasoning in ("xhigh", "max") else "--reasoning-effort"
        argv.extend([flag, reasoning])
    if "balanced" in implementation:
        argv.extend(["--quality-profile", "balanced"])
    if "neighborhood" in implementation:
        argv.append("--neighborhood")
    run_id = f"{os.environ.get('GITHUB_RUN_ID', 'local')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
    Path("arena_job.py").write_text(build_job(root, argv, implementation, run_id))
    Path("arena_stop.py").write_text(stop_job(run_id))


if __name__ == "__main__":
    main()
