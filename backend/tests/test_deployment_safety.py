import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import backend.db as db
import backend.solver as solver
from backend import main as backend_main
from backend.main import app
from scripts.configure_proxy_logging import redact_server_logs
from scripts import configure_proxy_logging

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_proxy_logging_policy_is_scoped_and_covers_nested_locations():
    before = '''# server { commented }
server { server_name other.example; access_log /var/log/other.log; }
server {
  server_name "shiftplanner.truhn.ai";
  access_log /var/log/app.log combined;
  location /api/ { error_log /var/log/api-error.log; proxy_pass http://backend; }
  location /literal { return 200 "a { quoted } value"; }
}
'''
    after, count = redact_server_logs(before, "shiftplanner.truhn.ai")
    assert count == 1
    assert 'server_name other.example; access_log /var/log/other.log;' in after
    assert '/var/log/app.log' not in after
    assert '/var/log/api-error.log' not in after
    assert 'proxy_pass http://backend;' in after
    assert 'return 200 "a { quoted } value";' in after
    assert 'access_log off;' in after and 'error_log /dev/null crit;' in after


@pytest.mark.parametrize("directive", ["access_log /var/log/private.log;", "error_log stderr;", "error_log off;"])
def test_proxy_rejects_transitive_included_log_overrides(tmp_path, directive):
    (tmp_path / "snippets").mkdir()
    (tmp_path / "shared").mkdir()
    (tmp_path / "snippets/api.conf").write_text("location /api/ { include shared/log-*.conf; }")
    # Relative nested includes resolve against nginx.conf's directory, not
    # the directory of snippets/api.conf.
    (tmp_path / "shared/log-private.conf").write_text(directive)
    server = "server { server_name app.example; include snippets/api.conf; }"
    with pytest.raises(ValueError, match="Unsafe .* override in shared nginx include"):
        redact_server_logs(server, "app.example", config_root=tmp_path)
    assert (tmp_path / "shared/log-private.conf").read_text() == directive


def test_proxy_allows_disabled_shared_logs_and_leaves_foreign_vhosts_untouched(tmp_path):
    include = tmp_path / "safe locations.conf"
    content = '''location /api/ {
      access_log off;
      access_log "/dev/null" combined;
      error_log '/dev/null' debug;
      set $argument access_log;
    }'''
    include.write_text(content)
    foreign = "server { server_name other.example; include missing-foreign.conf; access_log /var/log/other.log; }"
    text = foreign + f'\nserver {{ server_name app.example; include "{include}"; include optional-*.conf; set $argument error_log; }}'
    after, count = redact_server_logs(text, "app.example", config_root=tmp_path)
    assert count == 1 and after.startswith(foreign)
    assert "set $argument error_log;" in after
    assert include.read_text() == content


@pytest.mark.parametrize("path", ["$variable.conf", "missing.conf"])
def test_unverifiable_nginx_includes_fail_closed(tmp_path, path):
    server = f"server {{ server_name app.example; include {path}; }}"
    with pytest.raises(ValueError, match="Cannot verify"):
        redact_server_logs(server, "app.example", config_root=tmp_path)


def test_recursive_nginx_includes_fail_closed(tmp_path):
    (tmp_path / "recursive.conf").write_text("include recursive.conf;")
    with pytest.raises(ValueError, match="cyclic nginx include"):
        redact_server_logs("server { server_name app.example; include recursive.conf; }", "app.example", config_root=tmp_path)


def test_unsafe_include_rolls_back_all_previously_changed_files(tmp_path, monkeypatch):
    main = tmp_path / "nginx.conf"
    first, second, shared = [tmp_path / name for name in ("first.conf", "second.conf", "shared.conf")]
    main.write_text("http { include *.conf; }")
    first.write_text("server { server_name app.example; access_log /var/log/app.log; }")
    second.write_text("server { server_name app.example; include shared.conf; }")
    shared.write_text("location /api/ { access_log /var/log/private.log; }")
    before = {path: path.read_text() for path in (main, first, second, shared)}
    calls = []

    def nginx(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(stdout="\n".join(f"# configuration file {path}:" for path in before))

    monkeypatch.setattr(configure_proxy_logging.subprocess, "run", nginx)
    monkeypatch.setattr(sys, "argv", ["configure_proxy_logging", "--domain", "app.example"])
    with pytest.raises(ValueError, match="Unsafe access_log"):
        configure_proxy_logging.main()
    assert {path: path.read_text() for path in before} == before
    assert calls == [["nginx", "-T"]]


@pytest.mark.parametrize("failure", [["nginx", "-t"], ["nginx", "-s", "reload"]])
def test_proxy_validation_or_reload_failure_restores_original_files(tmp_path, monkeypatch, failure):
    main = tmp_path / "nginx.conf"
    before = "server { server_name app.example; access_log /var/log/app.log; }"
    main.write_text(before)

    def nginx(command, **kwargs):
        if command == failure:
            raise subprocess.CalledProcessError(1, command)
        return SimpleNamespace(stdout=f"# configuration file {main}:\n")

    monkeypatch.setattr(configure_proxy_logging.subprocess, "run", nginx)
    monkeypatch.setattr(sys, "argv", ["configure_proxy_logging", "--domain", "app.example"])
    with pytest.raises(subprocess.CalledProcessError):
        configure_proxy_logging.main()
    assert main.read_text() == before


def test_symlinked_main_config_keeps_its_original_include_prefix(tmp_path, monkeypatch):
    actual = tmp_path / "stored"
    actual.mkdir()
    target = actual / "main.conf"
    target.write_text("server { server_name app.example; include logging.conf; }")
    main = tmp_path / "nginx.conf"
    main.symlink_to(target)
    (actual / "logging.conf").write_text("access_log off;")
    (tmp_path / "logging.conf").write_text("access_log /var/log/private.log;")
    monkeypatch.setattr(configure_proxy_logging.subprocess, "run", lambda *a, **kw:
                        SimpleNamespace(stdout=f"# configuration file {main}:\n"))
    monkeypatch.setattr(sys, "argv", ["configure_proxy_logging", "--domain", "app.example"])
    with pytest.raises(ValueError, match="Unsafe access_log"):
        configure_proxy_logging.main()
    assert target.read_text() == "server { server_name app.example; include logging.conf; }"


def test_proxy_logging_rewrite_is_idempotent_and_reloads_only_on_change(tmp_path, monkeypatch, capsys):
    main = tmp_path / "nginx.conf"
    main.write_text("server {\n  server_name app.example;\n  access_log /var/log/app.log;\n"
                    "  location /api/ { error_log /var/log/api.log; proxy_pass http://backend; }\n}\n")
    calls = []

    def nginx(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(stdout=f"# configuration file {main}:\n")

    monkeypatch.setattr(configure_proxy_logging.subprocess, "run", nginx)
    assert configure_proxy_logging.run(["--domain", "app.example"]) == 0
    first = main.read_text()
    assert calls == [["nginx", "-T"], ["nginx", "-t"], ["nginx", "-s", "reload"]]
    assert first.count("access_log off;") == 1 and first.count("error_log /dev/null crit;") == 1
    assert "location /api/ { proxy_pass http://backend; }" in first
    assert "\n\n" not in first
    # Every deploy runs this again: an already configured server must neither
    # be rewritten (no whitespace growth) nor trigger an nginx reload.
    calls.clear()
    assert configure_proxy_logging.run(["--domain", "app.example"]) == 0
    assert main.read_text() == first
    assert calls == [["nginx", "-T"]]
    assert "already disabled" in capsys.readouterr().out
    # Hand-made whitespace changes are not a reason to rewrite either.
    spaced = first.replace("\n    error_log", "\n\n    error_log")
    main.write_text(spaced)
    calls.clear()
    assert configure_proxy_logging.run(["--domain", "app.example"]) == 0
    assert main.read_text() == spaced and calls == [["nginx", "-T"]]


@pytest.mark.parametrize("problem", ["no-server-block", "nginx-missing", "nginx-T-fails"])
def test_proxy_logging_problems_warn_instead_of_failing_the_deploy(tmp_path, monkeypatch, capsys, problem):
    main = tmp_path / "nginx.conf"
    main.write_text("server { server_name other.example; access_log /var/log/other.log; }")

    def nginx(command, **kwargs):
        if problem == "nginx-missing":
            raise FileNotFoundError(2, "No such file or directory", "nginx")
        if problem == "nginx-T-fails":
            raise subprocess.CalledProcessError(1, command, stderr="nginx: [emerg] bad config")
        return SimpleNamespace(stdout=f"# configuration file {main}:\n")

    monkeypatch.setattr(configure_proxy_logging.subprocess, "run", nginx)
    assert configure_proxy_logging.run(["--domain", "app.example"]) == 0
    captured = capsys.readouterr()
    assert captured.err.startswith("WARNING: proxy logging not configured: ")
    expected = {"no-server-block": "Application virtual server not found",
                "nginx-missing": "nginx", "nginx-T-fails": "[emerg] bad config"}[problem]
    assert expected in captured.err
    assert main.read_text() == "server { server_name other.example; access_log /var/log/other.log; }"
    with pytest.raises(Exception):
        configure_proxy_logging.run(["--domain", "app.example", "--strict"])


def test_proxy_logging_script_exits_zero_without_nginx_on_the_host(tmp_path):
    # The deploy workflow calls the script unconditionally under set -e with
    # whatever python3 the host has; it must import and warn, not abort.
    empty_path = tmp_path / "bin"
    empty_path.mkdir()
    result = subprocess.run([sys.executable, "-I", str(REPO_ROOT / "scripts/configure_proxy_logging.py"),
                             "--domain", "app.example"],
                            env={"PATH": str(empty_path)}, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert result.stderr.startswith("WARNING: proxy logging not configured: ")
    strict = subprocess.run([sys.executable, "-I", str(REPO_ROOT / "scripts/configure_proxy_logging.py"),
                             "--domain", "app.example", "--strict"],
                            env={"PATH": str(empty_path)}, capture_output=True, text=True, timeout=30)
    assert strict.returncode != 0


def test_proxy_logging_script_uses_python38_compatible_syntax():
    import ast
    source = (REPO_ROOT / "scripts/configure_proxy_logging.py").read_text()
    ast.parse(source, feature_version=(3, 8))
    # PEP 604 unions in signatures need postponed evaluation on 3.8/3.9.
    assert "from __future__ import annotations" in source.splitlines()[:20]


def test_startup_clears_stale_planning_drain_marker_before_recovery(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "schedule.db"))
    monkeypatch.setattr(db, "_SCHEMA_READY", False)
    marker = tmp_path / ".planning-drain"
    marker.touch()
    monkeypatch.setattr(backend_main, "_check_port_available", lambda *_args: None)
    monkeypatch.setattr(backend_main, "_ensure_admin_user", lambda: None)
    monkeypatch.setattr(backend_main, "_ensure_test_user", lambda: None)
    marker_seen_by_recovery = []
    monkeypatch.setattr(solver, "recover_interrupted_runs",
                        lambda: marker_seen_by_recovery.append(marker.exists()))
    with TestClient(app) as running_client:
        assert running_client.get("/health").status_code == 200
        assert not marker.exists()
    # Restarted runs are admitted like first attempts: the marker must be
    # gone before recovery, or every recovered run would be refused (503).
    assert marker_seen_by_recovery == [False]
    # A second start without a marker is a no-op.
    with TestClient(app):
        pass
    assert not marker.exists()


@pytest.mark.parametrize("worker_state,success,replaces", [("0", True, True), ("1", False, False), ("unknown", False, False), ("inspect-error", False, False), ("cleanup-error", False, True)])
def test_deployment_never_replaces_busy_or_uninspectable_workers(tmp_path, worker_state, success, replaces):
    fake = tmp_path / "docker"
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["DOCKER_CALLS"], "a") as output:
    output.write(json.dumps(sys.argv[1:]) + "\\n")
args = " ".join(sys.argv)
if "ps --status running --services" in args:
    print("backend\\nfrontend")
elif sys.argv[-2:] == ["python", "-"]:
    state = os.environ["WORKER_STATE"]
    if state == "inspect-error": sys.exit(7)
    print("0" if state == "cleanup-error" else state)
elif "unlink(missing_ok=True)" in args and os.environ["WORKER_STATE"] == "cleanup-error":
    sys.exit(9)
''')
    fake.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}",
               DOCKER_CALLS=str(calls), WORKER_STATE=worker_state,
               DEPLOY_DRAIN_POLLS="2", DEPLOY_DRAIN_INTERVAL="0")
    script = Path(__file__).resolve().parents[2] / "scripts/deploy-compose.sh"
    result = subprocess.run(["bash", str(script), "test-compose.yml"], env=env,
                            capture_output=True, text=True, timeout=10)
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    replacements = [args for args in recorded if "up" in args]
    assert (result.returncode == 0) is success, result.stderr
    assert bool(replacements) is replaces
    assert any("unlink(missing_ok=True)" in " ".join(args) for args in recorded)
    if worker_state == "cleanup-error":
        assert "Could not reopen planning admissions" in result.stderr
    if success:
        assert sum(args[-2:] == ["python", "-"] for args in recorded) == 2


@pytest.mark.parametrize("frontend_running", [True, False])
def test_deployment_heals_previous_drain_and_gates_frontend_only_when_running(tmp_path, frontend_running):
    fake = tmp_path / "docker"
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["DOCKER_CALLS"], "a") as output:
    output.write(json.dumps(sys.argv[1:]) + "\\n")
args = " ".join(sys.argv)
if "ps --status running --services" in args:
    print(os.environ["RUNNING_SERVICES"])
elif sys.argv[-2:] == ["python", "-"]:
    print("0")
''')
    fake.chmod(0o755)
    calls = tmp_path / "calls.jsonl"
    env = dict(os.environ, PATH=f"{tmp_path}:{os.environ['PATH']}", DOCKER_CALLS=str(calls),
               RUNNING_SERVICES="backend\nfrontend" if frontend_running else "backend",
               DEPLOY_DRAIN_POLLS="2", DEPLOY_DRAIN_INTERVAL="0")
    result = subprocess.run(["bash", str(REPO_ROOT / "scripts/deploy-compose.sh"), "test-compose.yml"],
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    recorded = [json.loads(line) for line in calls.read_text().splitlines()]
    build_at = recorded.index(["compose", "-f", "test-compose.yml", "build"])
    before_build = [" ".join(args) for args in recorded[:build_at]]
    gate = [args for args in recorded if "frontend" in args and "nginx-before-planning-drain.conf" in " ".join(args)]
    restores = [args for args in gate if "if [ -f /tmp/nginx-before-planning-drain.conf ]" in args[-1]]
    patches = [args for args in gate if "return 503" in args[-1]]
    # Leftovers of a run killed before its EXIT trap are removed before anything else.
    assert any("unlink(missing_ok=True)" in call for call in before_build)
    assert sum("frontend" in call and "nginx-before-planning-drain.conf" in call for call in before_build) == int(frontend_running)
    if frontend_running:
        assert len(patches) == 1 and patches[0][-2] == "-ec"
        assert len(restores) == 2  # self-heal and EXIT cleanup
        assert "skipping the nginx planning gate" not in result.stderr
    else:
        assert patches == []
        assert len(restores) == 1  # EXIT cleanup only
        assert "skipping the nginx planning gate" in result.stderr
    assert any("up" in args for args in recorded)


def test_idle_probe_recognizes_checkout_arena_jobs_and_ignores_itself(tmp_path):
    from scripts.count_planning_processes import count_planning_processes
    commands = {
        1: b"python\0-m\0uvicorn\0backend.main:app\0",
        2: b"python\0-c\0from multiprocessing.spawn import spawn_main; spawn_main()\0",
        3: b"python\0-m\0backend.arena.run\0",
        4: b"/usr/local/bin/python3\0-\0",  # checkout package piped over SSH
        5: b"python\0-\0",  # this idle probe
        6: b"nginx\0",
    }
    for pid, command in commands.items():
        folder = tmp_path / str(pid)
        folder.mkdir()
        (folder / "cmdline").write_bytes(command)
    assert count_planning_processes(tmp_path, own_pid=5) == 3
