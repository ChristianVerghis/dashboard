"""One ignore policy for everything that looks at project files: the scanner's
file stats, the file watcher, and (through the scanner) the activity feed.

The scanner and the watcher used to keep separate lists. The watcher's was
shorter, so a Chrome profile under careers/.browser-profile and Unreal's
ATLA/Intermediate kept invalidating scans the scanner itself would never look
at, and the process sat at 200-400 % CPU after a few days up.
"""
from __future__ import annotations

# Directory names that are never project work: dependencies, build output,
# caches, editor state, runtime logs. Any dot-directory is skipped as well.
DIR_NAMES = frozenset({
    "node_modules", "__pycache__", "venv",
    "dist", "build", "target", "coverage", "out",
    "logs",
    # Unreal Engine output and caches
    "Saved", "Intermediate", "DerivedDataCache", "Binaries", "Builds",
})

# Path fragments for data a running service rewrites constantly. Classroom's
# short-term cohort writes thousands of lines a second during a replay.
PATH_FRAGMENTS = (
    "/shortterm/sessions/", "/shortterm/students/", "/shortterm/data/",
)

# File name endings that are churn, never work.
FILE_SUFFIXES = (
    "-wal", "-shm", "-journal", ".log", ".pid", ".lock", ".sock",
    ".swp", ".swo", "~", ".tmp", ".DS_Store",
)

# Inside .git only these change when the repo state a tile shows changes:
# a commit, checkout, reset, fetch or push. .git/index is deliberately absent:
# `git status` rewrites it, which would loop a rescan into another rescan.
GIT_STATE_FILES = ("/.git/HEAD", "/.git/logs/HEAD", "/.git/packed-refs", "/.git/FETCH_HEAD")
GIT_STATE_DIRS = ("/.git/refs/",)


def skip_dir(name: str) -> bool:
    """For os.walk pruning."""
    return name.startswith(".") or name in DIR_NAMES


def skip_rel_path(rel: str) -> bool:
    """True for a project-relative file path ('a/b/c.py') that is not work."""
    parts = rel.split("/")
    name = parts[-1]
    if name.startswith(".") or name.endswith(FILE_SUFFIXES):
        return True
    for seg in parts[:-1]:
        if seg.startswith(".") or seg in DIR_NAMES:
            return True
    probe = "/" + rel
    return any(frag in probe for frag in PATH_FRAGMENTS)


def is_git_state_event(path: str) -> bool:
    return path.endswith(GIT_STATE_FILES) or any(d in path for d in GIT_STATE_DIRS)


def watcher_should_ignore(path: str, root: str) -> bool:
    """For an absolute event path under the projects root."""
    if "/.git/" in path:
        return not is_git_state_event(path)
    prefix = root.rstrip("/") + "/"
    if not path.startswith(prefix):
        return True
    rel = path[len(prefix):]
    # drop the project folder itself; a dot-project folder is ignored outright
    head, _, rest = rel.partition("/")
    if not rest or head.startswith("."):
        return True
    return skip_rel_path(rest)
