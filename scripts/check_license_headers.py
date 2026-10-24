#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>
# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck

"""
check_license_headers.py

License-header compliance checker and auto-fixer for the DBCheck repository.

Pure standard library (Python 3.8+). No third-party dependencies.

What it does
------------
* Walks the repository (relative to the Git/working-tree root, by default the
  parent directory of this script) and collects all first-party ``*.py`` files.
* Skips vendored / generated / data directories and any file that already
  carries a genuine non-Apache third-party license header (for example the
  bundled ``modules/disaster_recovery/vendor/autobackup.py`` which is MIT
  licensed and must keep its own header).
* Verifies that every first-party file carries ALL of:
      - a ``SPDX-License-Identifier: Apache-2.0`` line,
      - a ``Copyright 2025-2026 fiyo (Jack Ge)`` line, and
      - the author email ``sdfiyon@gmail.com`` (removing the email fails).
* Verifies that the root ``LICENSE`` file references the Apache License and that
  a root ``NOTICE`` file exists.
* With ``--fix`` it rewrites/inserts the canonical three-line Apache 2.0 header
  into every non-compliant first-party file.

Exit codes
----------
* 0  -> everything is compliant (or was made compliant by --fix)
* 1  -> one or more license requirements are missing
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

# Directory name components that are always excluded (matched as a single path
# segment, case-sensitive).
EXCLUDED_DIR_COMPONENTS = {
    "__pycache__",
    ".git",
    "node_modules",
    "dist",
    "build",
    "reports",
    "snapshot",
    "awr_uploads",
    "copyright_registration",
    "pro_data",
    "data",
    # Local virtualenv (third-party site-packages): never first-party source,
    # otherwise the walk reports thousands of library files as "missing header".
    ".venv",
    "venv",
    # Throwaway local test/probe dirs (never committed; keep the checker clean).
    ".acceptance_tmp",
    ".pytest_tmp",
    "_qa_tmp",
    "qa-temp",
}

# Path fragments (forward-slash normalised) that mark vendored / bundled code
# which keeps its own third-party license header.
EXCLUDED_PATH_FRAGMENTS = (
    "/vendor/",       # e.g. modules/disaster_recovery/vendor/autobackup.py
    "static/vendor/",
)

# The canonical header we want at the top of every first-party file.
APACHE_HEADER_LINES = [
    "# SPDX-License-Identifier: Apache-2.0",
    "# Copyright 2025-2026 fiyo (Jack Ge) <sdfiyon@gmail.com>",
    "# Author: fiyo (Jack Ge) - https://github.com/fiyo/DBCheck",
]

# Markers (lower-cased) that, when present in a file header together with a
# copyright holder OTHER than fiyo, indicate a genuine third-party license that
# must be preserved (not rewritten to Apache-2.0).
THIRD_PARTY_MARKERS = (
    "mit license",
    "bsd license",
    "bsd-2",
    "bsd-3",
    "gnu lesser",
    "gnu general public",
    "mozilla public license",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalise(path: str) -> str:
    """Normalise a path to forward slashes for stable fragment matching."""
    return path.replace("\\", "/")


def is_excluded_by_path(rel_path: str) -> bool:
    """Return True if *rel_path* should be skipped based on its location."""
    norm = _normalise(rel_path)
    parts = Path(norm).parts
    for component in parts:
        if component in EXCLUDED_DIR_COMPONENTS:
            return True
    for frag in EXCLUDED_PATH_FRAGMENTS:
        if frag in norm:
            return True
    return False


def has_third_party_header(text: str) -> bool:
    """Detect a genuine third-party (non-Apache) license header.

    First-party DBCheck files may mention "MIT" (e.g. "MIT License with
    Attribution Requirements") but are attributed to *fiyo*, so they are NOT
    treated as third-party and will be normalised to Apache-2.0.
    """
    head = "\n".join(text.split("\n", 30)[:30]).lower()
    for marker in THIRD_PARTY_MARKERS:
        if marker in head:
            if "fiyo" not in head and "jack ge" not in head:
                return True
    return False


def collect_first_party_py_files() -> list[Path]:
    """Return a sorted list of first-party *.py files (relative to REPO_ROOT)."""
    results: list[Path] = []
    for path in REPO_ROOT.rglob("*.py"):
        rel = path.relative_to(REPO_ROOT)
        rel_str = _normalise(str(rel))
        if is_excluded_by_path(rel_str):
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            continue
        if has_third_party_header(text):
            continue
        results.append(rel)
    results.sort(key=lambda p: _normalise(str(p)))
    return results


def file_is_compliant(path: Path) -> bool:
    """A file is compliant if it carries the SPDX id, a fiyo Copyright line and the author email."""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return False
    has_spdx = "SPDX-License-Identifier: Apache-2.0" in text
    has_copyright = bool(re.search(r"Copyright 2025-2026 fiyo", text))
    has_email = "sdfiyon@gmail.com" in text
    return has_spdx and has_copyright and has_email


def find_license_block(lines: list[str], start: int):
    """Find the contiguous comment/blank run starting at *start* that contains a
    license marker. Returns (block_start, block_end) or None.
    """
    n = len(lines)
    if start >= n:
        return None
    i = start
    while i < n and (lines[i].strip() == "" or lines[i].lstrip().startswith("#")):
        i += 1
    run_start, run_end = start, i
    if run_start >= run_end:
        return None
    block_text = "\n".join(lines[run_start:run_end]).lower()
    license_markers = (
        "copyright",
        "spdx-license-identifier",
        "see license",
        "released under",
        "licensed under",
        "all rights reserved",
        "proprietary software",
    )
    if any(m in block_text for m in license_markers):
        return (run_start, run_end)
    return None


def _read_raw(path: Path):
    """Read file as text, returning (text, has_bom)."""
    raw = path.read_bytes()
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    return text, has_bom


def _write_raw(path: Path, text: str, has_bom: bool) -> None:
    """Write text back, preserving the BOM if it was present."""
    data = text.encode("utf-8")
    if has_bom:
        data = b"\xef\xbb\xbf" + data
    path.write_bytes(data)


def fix_file(rel_path: Path) -> bool:
    """Insert or replace the Apache-2.0 header. Returns True if the file changed."""
    abs_path = REPO_ROOT / rel_path
    text, has_bom = _read_raw(abs_path)
    lines = text.split("\n")

    # 1. Extract a leading shebang (must stay on line 0).
    shebang = None
    idx = 0
    if lines and lines[0].startswith("#!"):
        shebang = lines[0]
        idx = 1

    # 2. Extract a single optional coding declaration right after the shebang.
    coding = None
    if idx < len(lines) and re.match(r"^#.*coding[:=]", lines[idx].lstrip()):
        coding = lines[idx]
        idx += 1

    # 3. Detect an existing license block to replace (if any).
    block = find_license_block(lines, idx)

    # Already exactly compliant? (correct SPDX + fiyo copyright line, no stale block)
    already_apache = (
        "SPDX-License-Identifier: Apache-2.0" in text
        and bool(re.search(r"# Copyright 2025-2026 fiyo \(Jack Ge\)", text))
        and "sdfiyon@gmail.com" in text
    )
    if already_apache and block is None:
        return False

    # 4. Build the new preamble.
    preamble: list[str] = []
    if shebang is not None:
        preamble.append(shebang)
    if coding is not None:
        preamble.append(coding)
    preamble.extend(APACHE_HEADER_LINES)
    preamble.append("")  # single trailing blank line separating header from body

    if block is not None:
        rest = lines[block[1]:]
    else:
        rest = lines[idx:]

    # Strip leading blank lines from the remaining body to avoid double blanks.
    while rest and rest[0].strip() == "":
        rest.pop(0)

    new_lines = preamble + rest
    new_text = "\n".join(new_lines)
    if new_text == text:
        return False
    _write_raw(abs_path, new_text, has_bom)
    return True


def check_root_license_and_notice() -> list[str]:
    """Return a list of problems with the root LICENSE / NOTICE files."""
    problems: list[str] = []
    license_path = REPO_ROOT / "LICENSE"
    if not license_path.is_file():
        problems.append("Missing root LICENSE file")
    else:
        lic_text = license_path.read_text(encoding="utf-8-sig").lower()
        if "apache license" not in lic_text or "version 2.0" not in lic_text:
            problems.append(
                "Root LICENSE does not contain 'Apache License' / 'Version 2.0'"
            )
    if not (REPO_ROOT / "NOTICE").is_file():
        problems.append("Missing root NOTICE file")
    return problems


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    global REPO_ROOT
    parser = argparse.ArgumentParser(
        description="Check/fix Apache-2.0 license headers in first-party *.py files."
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Insert/replace the Apache-2.0 header in non-compliant files.",
    )
    parser.add_argument(
        "--root",
        default=str(REPO_ROOT),
        help="Repository root (default: parent directory of this script).",
    )
    args = parser.parse_args(argv)

    REPO_ROOT = Path(args.root).resolve()

    files = collect_first_party_py_files()

    missing: list[str] = []
    fixed: list[str] = []

    for rel in files:
        abs_path = REPO_ROOT / rel
        if args.fix:
            if fix_file(rel):
                fixed.append(_normalise(str(rel)))
            if not file_is_compliant(abs_path):
                missing.append(_normalise(str(rel)))
        else:
            if not file_is_compliant(abs_path):
                missing.append(_normalise(str(rel)))

    root_problems = check_root_license_and_notice()

    if args.fix:
        if fixed:
            print(f"FIX: wrote Apache-2.0 header to {len(fixed)} file(s):")
            for f in fixed:
                print(f"  + {f}")
        else:
            print("FIX: 0 files needed changes (all first-party files compliant).")

    if missing:
        print("\nMissing license headers in the following first-party file(s):")
        for f in missing:
            print(f"  - {f}")
        print(f"\nFAIL: {len(missing)} file(s) missing required license header.")
        for p in root_problems:
            print(f"  - {p}")
        return 1

    if root_problems:
        print("\nRoot license file problems:")
        for p in root_problems:
            print(f"  - {p}")
        print("\nFAIL: root license/NOTICE check failed.")
        return 1

    print(f"OK: {len(files)} files checked, 0 missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
