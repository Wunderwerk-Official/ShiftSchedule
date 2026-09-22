"""Conservative idle probe: app workers, arena modules and stdin arena jobs."""
import os
from pathlib import Path


def count_planning_processes(proc_root=Path("/proc"), own_pid=None):
    own_pid = os.getpid() if own_pid is None else own_pid
    count = 0
    for entry in proc_root.glob("[0-9]*/cmdline"):
        if entry.parent.name == str(own_pid):
            continue
        try:
            arguments = entry.read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError):
            continue  # A process exiting during enumeration is normal.
        command = b" ".join(arguments)
        python_stdin = (len(arguments) > 1 and arguments[1] == b"-"
                        and Path(os.fsdecode(arguments[0])).name.startswith("python"))
        if b"spawn_main" in command or b"backend.arena" in command or python_stdin:
            count += 1
    return count


if __name__ == "__main__":
    print(count_planning_processes())
