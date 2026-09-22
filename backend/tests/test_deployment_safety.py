import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from scripts.configure_proxy_logging import redact_server_logs
from scripts import configure_proxy_logging


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
