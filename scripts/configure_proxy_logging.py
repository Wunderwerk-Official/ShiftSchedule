"""Disable raw URL logs only in the application's host-nginx virtual servers.

The API keeps redacted route/status/error-class logs. Nginx does not reliably
redact capability tokens in error messages, so these virtual servers must not
write raw access/error request URLs. Other virtual servers remain unchanged.
"""
import argparse
import glob
from pathlib import Path
import re
import subprocess

TOKEN = re.compile(r'''\#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|[^\s{};]+''')


def _directives(tokens):
    """Yield semicolon directives, not keywords appearing as argument values."""
    parts = []
    for token in tokens:
        if token.group() in ("{", "}"):
            parts = []
        elif token.group() == ";":
            if parts:
                yield parts[0], parts[1:], token
            parts = []
        else:
            parts.append(token)


def _literal(token):
    value = token.group()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return value


def _check_includes(tokens, config_root: Path | None, *, stack=(), checked=None):
    """Shared include files are read-only. Refuse any unsafe nested override.

    Nginx resolves relative includes against its main configuration prefix,
    even when an include appears in a file in a different directory.
    """
    if checked is None:
        checked = set()
    for directive, arguments, _ in _directives(tokens):
        if directive.group() != "include":
            continue
        if config_root is None:
            raise ValueError("Cannot verify nginx includes without the main configuration directory.")
        if len(arguments) != 1:
            raise ValueError("Cannot verify nginx include: expected one static path or glob.")
        pattern = _literal(arguments[0])
        if not pattern or "$" in pattern or "\\" in pattern:
            raise ValueError("Cannot verify nginx include: variable or escaped paths are not supported.")
        pattern_path = Path(pattern)
        if not pattern_path.is_absolute():
            pattern_path = config_root / pattern_path
        paths = sorted(Path(name).resolve() for name in glob.glob(str(pattern_path)))
        if not paths and not glob.has_magic(pattern):
            raise ValueError(f"Cannot verify missing nginx include: {pattern_path}")
        for path in paths:
            if path in stack:
                raise ValueError(f"Cannot verify cyclic nginx include: {path}")
            if path in checked:
                continue
            nested = [m for m in TOKEN.finditer(path.read_text()) if not m.group().startswith("#")]
            for name, args, _ in _directives(nested):
                values = [_literal(arg) for arg in args]
                safe = bool(values) and values[0] == "/dev/null"
                safe |= name.group() == "access_log" and values == ["off"]
                if name.group() in ("access_log", "error_log") and not safe:
                    raise ValueError(f"Unsafe {name.group()} override in shared nginx include {path}; "
                                     "disable that log or use /dev/null before deployment. No shared include was modified.")
            _check_includes(nested, config_root, stack=(*stack, path), checked=checked)
            checked.add(path)


def redact_server_logs(text: str, domain: str, *, config_root: Path | None = None) -> tuple[str, int]:
    tokens = [m for m in TOKEN.finditer(text) if not m.group().startswith("#")]
    edits = []
    matched = 0
    for i, token in enumerate(tokens[:-1]):
        if token.group() != "server" or tokens[i + 1].group() != "{":
            continue
        depth, end = 1, i + 2
        while end < len(tokens) and depth:
            depth += (tokens[end].group() == "{") - (tokens[end].group() == "}")
            end += 1
        if depth:
            raise ValueError("Unbalanced nginx server block")
        block = tokens[i + 2:end - 1]
        names = []
        for item, arguments, _ in _directives(block):
            if item.group() == "server_name":
                names.extend(_literal(name) for name in arguments)
        if domain not in names:
            continue
        _check_includes(block, config_root)
        matched += 1
        for item, _, terminator in _directives(block):
            if item.group() not in ("access_log", "error_log"):
                continue
            # Existing same-level directives would duplicate the ones added
            # below. Remove them at all levels and inherit the server policy.
            edits.append((item.start(), terminator.end(), ""))
        at = tokens[i + 1].end()
        edits.append((at, at, "\n    access_log off;\n    error_log /dev/null crit;"))
    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text, matched


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True)
    args = parser.parse_args()
    result = subprocess.run(["nginx", "-T"], check=True, capture_output=True, text=True)
    # nginx -T prints the main configuration first, followed by its includes.
    # Preserve that order: relative paths use the main file's directory.
    reported_paths = [Path(p) for p in re.findall(r"^# configuration file (.+):$", result.stdout, re.M)]
    if not reported_paths:
        raise RuntimeError("Nginx did not report its configuration files; logging policy was not changed.")
    # A symlinked nginx.conf still uses the directory in its configured
    # pathname as the include prefix, not the symlink target's directory.
    config_root = reported_paths[0].absolute().parent
    paths = list(dict.fromkeys(path.resolve() for path in reported_paths))
    backups = {}
    matched = 0
    try:
        for path in paths:
            before = path.read_text()
            after, count = redact_server_logs(before, args.domain, config_root=config_root)
            matched += count
            if after != before:
                backups[path] = before
                path.write_text(after)
        if not matched:
            raise RuntimeError("Application virtual server not found; logging policy was not changed.")
        subprocess.run(["nginx", "-t"], check=True, capture_output=True)
        subprocess.run(["nginx", "-s", "reload"], check=True, capture_output=True)
    except Exception:
        for path, before in backups.items():
            path.write_text(before)
        raise
    print(f"Private URL logging disabled in {matched} application virtual server(s).")


if __name__ == "__main__":
    main()
