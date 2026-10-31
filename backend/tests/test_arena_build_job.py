import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

from backend.arena.build_job import build_job


def test_checkout_experiment_uses_packaged_code_and_reads_settings_without_writes(tmp_path):
    root = tmp_path / "checkout"
    arena = root / "backend/arena"
    arena.mkdir(parents=True)
    (root / "backend/__init__.py").write_text("")
    (root / "backend/agent_budget.py").write_text("def _read_rows(): raise RuntimeError('deployed database helper must not run')")
    (arena / "fixture_complex.json").write_text("{}")
    (arena / "prompt_eval.py").write_text(
        "import json, pathlib, backend.agent_budget as budget\n"
        "print(json.dumps({'settings':budget._read_rows(), 'module':budget.__file__}))\n")
    database = tmp_path / "settings.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE agent_settings (key TEXT, value TEXT)")
        connection.execute("INSERT INTO agent_settings VALUES ('provider','mock')")
    original = database.read_bytes()
    job = build_job(root, ["prompt_eval"], "checkout")
    result = subprocess.run([sys.executable, "-"], input=job, text=True, capture_output=True,
                            env={**os.environ, "SCHEDULE_DB_PATH": str(database)}, check=True)
    output = json.loads(result.stdout)
    assert output["settings"] == {"provider": "mock"}
    assert "shift-arena-" in output["module"]
    assert not Path(output["module"]).exists()  # temporary checkout was cleaned up
    assert database.read_bytes() == original


def _forwarded_argv(monkeypatch, tmp_path, **env):
    import backend.arena.build_job as module

    captured = {}
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(module, "build_job", lambda root, argv, impl, *_: captured.setdefault("argv", argv) and "")
    for name in ("START", "DAYS", "TIMEOUT", "MODEL", "SCENARIO", "STRATEGY", "VARIANT", "PROVIDER",
                 "REASONING", "IMPLEMENTATION"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GITHUB_SHA", "abc")
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    module.main()
    return captured["argv"]


def test_the_workflow_inputs_reach_the_experiment(monkeypatch, tmp_path):
    argv = _forwarded_argv(monkeypatch, tmp_path, PROVIDER="anthropic", MODEL="claude-opus-5-5",
                           TIMEOUT="0", REASONING="low")
    assert argv == ["prompt_eval", "--evaluation-ref", "abc", "--timeout", "0", "--model", "claude-opus-5-5",
                    "--provider", "anthropic", "--reasoning-effort", "low"]


def test_claude_only_effort_levels_use_the_effort_flag(monkeypatch, tmp_path):
    argv = _forwarded_argv(monkeypatch, tmp_path, PROVIDER="anthropic", REASONING="xhigh")
    assert argv[-2:] == ["--effort", "xhigh"]
    # An empty model input keeps the saved model.
    assert "--model" not in argv


def test_the_job_records_its_pid_only_while_it_runs(tmp_path):
    from backend.arena.build_job import pid_file_name

    root = tmp_path / "checkout"
    arena = root / "backend/arena"
    arena.mkdir(parents=True)
    (root / "backend/__init__.py").write_text("")
    (root / "backend/agent_budget.py").write_text("")
    (arena / "fixture_complex.json").write_text("{}")
    (arena / "prompt_eval.py").write_text(
        "import os, pathlib, tempfile\n"
        f"print(pathlib.Path(tempfile.gettempdir(), {pid_file_name('7-1')!r}).read_text() == str(os.getpid()))\n")
    temp = tmp_path / "tmp"
    temp.mkdir()
    job = build_job(root, ["prompt_eval", "--mock"], "checkout", run_id="7-1")
    result = subprocess.run([sys.executable, "-"], input=job, text=True, capture_output=True,
                            env={**os.environ, "TMPDIR": str(temp)}, check=True)
    assert result.stdout.strip() == "True"
    assert list(temp.iterdir()) == []


def _run_stop(temp, run_id="7-1"):
    from backend.arena.build_job import stop_job

    return subprocess.run([sys.executable, "-"], input=stop_job(run_id), text=True, capture_output=True,
                          env={**os.environ, "TMPDIR": str(temp)}, check=True).stdout


def test_the_cancel_step_stops_the_recorded_arena_process(tmp_path):
    from backend.arena.build_job import pid_file_name

    arena = subprocess.Popen([sys.executable, "-"], stdin=subprocess.PIPE)
    try:
        (tmp_path / pid_file_name("7-1")).write_text(str(arena.pid))
        assert "Stopped arena process" in _run_stop(tmp_path)
        assert arena.wait(timeout=10) != 0
        assert not (tmp_path / pid_file_name("7-1")).exists()
    finally:
        arena.kill()
    assert "No arena process" in _run_stop(tmp_path)


def test_the_cancel_step_leaves_a_reused_pid_alone(tmp_path):
    from backend.arena.build_job import pid_file_name

    other = subprocess.Popen(["sleep", "30"])
    try:
        (tmp_path / pid_file_name("7-1")).write_text(str(other.pid))
        assert "no longer the arena job" in _run_stop(tmp_path)
        assert other.poll() is None
    finally:
        other.kill()


def test_the_workflow_gets_a_stop_script_for_its_run(monkeypatch, tmp_path):
    monkeypatch.setenv("GITHUB_RUN_ID", "991")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    _forwarded_argv(monkeypatch, tmp_path)
    assert "shift-arena-991-2.pid" in (tmp_path / "arena_stop.py").read_text()
