"""Keep bearer URLs out of request logs without losing route/status diagnostics."""
import logging
import re
from urllib.parse import unquote


def safe_request_target(target: str) -> str:
    # ASGI/Uvicorn provide an origin-form request target. Parsing it as an
    # absolute URL can interpret // as a netloc and fail on malformed input.
    # Strip queries before decoding so encoded delimiters stay part of the
    # path component that must be redacted.
    path = unquote(target.split("?", 1)[0].split("#", 1)[0])

    def redact_public_api(match):
        prefix, component = match.groups()
        # Account publication management has no credential in this segment.
        if component == "publish":
            return match.group(0)
        suffix = ".ics" if prefix.endswith("/ical/") and component.endswith(".ics") else ""
        return prefix + "[redacted]" + suffix

    # Redact even malformed public URLs: a misspelled suffix may return 404,
    # but still contains the caller's valid bearer token.
    path = re.sub(r"(/(?:api/)?v1/(?:ical|web)/)([^/]+)", redact_public_api, path)
    path = re.sub(r"(/(?:public|print)/)[^/]+", r"\1[redacted]", path)
    return path.replace("\n", "").replace("\r", "")


class SafeAccessFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Uvicorn: (client, method, full_path, http_version, status_code).
        if isinstance(record.args, tuple) and len(record.args) == 5:
            args = list(record.args)
            args[2] = safe_request_target(str(args[2]))
            record.args = tuple(args)
        return True


def install_access_filter() -> None:
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, SafeAccessFilter) for f in logger.filters):
        logger.addFilter(SafeAccessFilter())
