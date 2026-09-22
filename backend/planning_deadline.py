"""An existing cancellation event combined with the remaining run budget."""
import time


class DeadlineCancellation:
    def __init__(self, event, seconds, started_at):
        self.event = event
        self.deadline = None
        if seconds:
            remaining = max(0.0, seconds - max(0.0, time.time() - started_at))
            self.deadline = time.monotonic() + remaining

    @property
    def expired(self):
        return self.deadline is not None and time.monotonic() >= self.deadline

    def is_set(self):
        return (self.event is not None and self.event.is_set()) or self.expired
