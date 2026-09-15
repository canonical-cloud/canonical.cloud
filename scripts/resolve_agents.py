#!/usr/bin/env python3
"""Discover and validate hierarchical agent instructions during AGENTS.md migration.

Modern repositories use uppercase ``AGENTS.md`` as the canonical authority.
During the fleet migration, the historical layout remains accepted when and
only when lowercase ``agents.md`` is the full authority and uppercase
``AGENTS.md`` is the exact minimal pointer to it. Divergent case variants fail
closed so Linux cannot silently accept an ambiguity that would collide on
case-insensitive macOS/Windows checkouts.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Iterable, Sequence

LEGACY_ROOT_POINTER = """# Agent instructions

Canonical repository instructions live in [`agents.md`](agents.md).
"""
MODERN_TOOL_POINTER = """# Agent instructions

Canonical repository instructions live in [`AGENTS.md`](../AGENTS.md).
"""
LEGACY_TOOL_POINTER = """# Agent instructions

Canonical repository instructions live in [`agents.md`](../agents.md).
"""
TOOL_POINTER_PATHS = (
    Path(".claude/CLAUDE.md"),
    Path(".gemini/GEMINI.md"),
    Path(".openai/AGENTS.md"),
)


class DiscoveryError(RuntimeError):
    """One or more candidate instruction files could not be used safely."""


def _ancestors_root_to_leaf(directory: Path) -> list[Path]:
    lineage: list[Path] = []
    current = directory
    while True:
        lineage.append(current)
        if current.parent == current:
            break
        current = current.parent
    lineage.reverse()
    return lineage


def _exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def _read_regular(path: Path) -> tuple[Path, os.stat_result, str]:
    try:
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("resolved target is not a regular file")
        text = resolved.read_text(encoding="utf-8")
        return resolved, metadata, text
    except (OSError, RuntimeError, UnicodeError) as error:
        raise DiscoveryError(f"{path}: {error}") from error


def _canonical_candidate(directory: Path) -> Path | None:
    upper = directory / "AGENTS.md"
    lower = directory / "agents.md"
    upper_exists = _exists(upper)
    lower_exists = _exists(lower)

    if not upper_exists and not lower_exists:
        return None
    if upper_exists and not lower_exists:
        return upper
    if lower_exists and not upper_exists:
        return lower

    try:
        if upper.samefile(lower):
            return upper
    except (OSError, RuntimeError) as error:
        raise DiscoveryError(f"cannot compare case-variant instruction files in {directory}: {error}") from error

    _, _, upper_text = _read_regular(upper)
    _read_regular(lower)
    if upper_text == LEGACY_ROOT_POINTER:
        return lower
    raise DiscoveryError(
        f"ambiguous case-variant instruction authorities in {directory}: "
        "modern repositories must keep only AGENTS.md; legacy repositories may "
        "keep agents.md only when AGENTS.md is the exact minimal pointer"
    )


def discover(start: Path | str) -> list[Path]:
    """Return readable canonical instruction files in root-to-leaf order."""

    requested = Path(start).expanduser()
    try:
        resolved_start = requested.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise DiscoveryError(f"cannot resolve start path {requested}: {error}") from error
    if not resolved_start.is_dir():
        resolved_start = resolved_start.parent

    discovered: list[Path] = []
    seen_files: set[tuple[int, int]] = set()
    errors: list[str] = []

    for directory in _ancestors_root_to_leaf(resolved_start):
        try:
            candidate = _canonical_candidate(directory)
            if candidate is None:
                continue
            resolved, metadata, _ = _read_regular(candidate)
        except DiscoveryError as error:
            errors.append(str(error))
            continue

        identity = (metadata.st_dev, metadata.st_ino)
        if identity in seen_files:
            continue
        seen_files.add(identity)
        discovered.append(resolved)

    if errors:
        details = "\n".join(f"- {message}" for message in errors)
        raise DiscoveryError(f"unusable agent instruction candidate(s):\n{details}")
    return discovered


def render(paths: Iterable[Path]) -> str:
    sections: list[str] = []
    for path in paths:
        text = path.read_text(encoding="utf-8")
        sections.append(f"===== BEGIN {path} =====\n{text.rstrip()}\n===== END {path} =====")
    return "\n\n".join(sections)


def repository_root() -> Path:
    return Path(__file__).resolve(strict=True).parents[1]


def resolve_repository_root(value: Path | None) -> Path:
    requested = repository_root() if value is None else value.expanduser()
    try:
        resolved = requested.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise DiscoveryError(f"cannot resolve repository root {requested}: {error}") from error
    if not resolved.is_dir():
        raise DiscoveryError(f"repository root is not a directory: {resolved}")
    return resolved


def _layout_mode(root: Path) -> tuple[str, Path, str]:
    upper = root / "AGENTS.md"
    lower = root / "agents.md"
    upper_exists = _exists(upper)
    lower_exists = _exists(lower)

    if upper_exists and not lower_exists:
        _, _, text = _read_regular(upper)
        return "modern", upper, text

    if upper_exists and lower_exists:
        try:
            if upper.samefile(lower):
                _, _, text = _read_regular(upper)
                return "modern", upper, text
        except (OSError, RuntimeError) as error:
            raise DiscoveryError(f"cannot compare root instruction aliases: {error}") from error

        _, _, upper_text = _read_regular(upper)
        _, _, lower_text = _read_regular(lower)
        if upper_text == LEGACY_ROOT_POINTER:
            return "legacy", lower, lower_text
        raise DiscoveryError(
            "AGENTS.md and agents.md are independent files but AGENTS.md is not "
            "the exact legacy pointer; refuse ambiguous case-variant authorities"
        )

    if lower_exists and not upper_exists:
        raise DiscoveryError(
            "legacy agents.md requires the exact uppercase AGENTS.md pointer during migration"
        )

    raise DiscoveryError("missing canonical instruction file: expected AGENTS.md")


def validate_layout(root: Path) -> None:
    mode, canonical, canonical_text = _layout_mode(root)
    if len(canonical_text.strip()) < 80:
        raise DiscoveryError(f"canonical {canonical.name} is unexpectedly small")

    expected_pointer = MODERN_TOOL_POINTER if mode == "modern" else LEGACY_TOOL_POINTER
    expected_target = "../AGENTS.md" if mode == "modern" else "../agents.md"
    failures: list[str] = []

    for relative in TOOL_POINTER_PATHS:
        pointer = root / relative
        try:
            actual = pointer.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            failures.append(f"{relative}: {error}")
            continue
        if actual != expected_pointer:
            failures.append(f"{relative}: must be the minimal pointer to {expected_target}")
        if actual == canonical_text:
            failures.append(f"{relative}: duplicates canonical instructions")

    try:
        chain = discover(root)
    except DiscoveryError as error:
        failures.append(str(error))
    else:
        if chain != [canonical.resolve(strict=True)]:
            failures.append(f"repository-root discovery mismatch: {chain!r}")

    if failures:
        raise DiscoveryError("invalid agent instruction layout:\n- " + "\n- ".join(failures))


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _full_policy(label: str) -> str:
    return f"# {label}\n\n" + ("portable non-destructive repository guidance " * 4) + "\n"


def _write_tool_pointers(root: Path, pointer: str) -> None:
    for relative in TOOL_POINTER_PATHS:
        _write(root / relative, pointer)


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="agents-hierarchy-") as temporary:
        temp = Path(temporary).resolve(strict=True)

        modern = temp / "modern"
        nested = modern / "services" / "api" / "src"
        sibling = modern / "sibling"
        nested.mkdir(parents=True)
        sibling.mkdir(parents=True)
        _write(modern / "AGENTS.md", _full_policy("Modern root"))
        _write(modern / "services" / "AGENTS.md", _full_policy("Service"))
        _write(sibling / "AGENTS.md", _full_policy("Sibling must not load"))
        _write_tool_pointers(modern, MODERN_TOOL_POINTER)

        expected = [
            (modern / "AGENTS.md").resolve(strict=True),
            (modern / "services" / "AGENTS.md").resolve(strict=True),
        ]
        chain = discover(nested)
        if chain != expected:
            raise AssertionError(f"modern root-to-leaf chain mismatch: {chain!r}")
        validate_layout(modern)

        duplicate = modern / "services" / "api" / "AGENTS.md"
        duplicate.symlink_to(modern / "AGENTS.md")
        if discover(nested) != expected:
            raise AssertionError("resolved-file deduplication failed")

        legacy = temp / "legacy"
        _write(legacy / "agents.md", _full_policy("Legacy root"))
        _write(legacy / "AGENTS.md", LEGACY_ROOT_POINTER)
        _write_tool_pointers(legacy, LEGACY_TOOL_POINTER)
        validate_layout(legacy)
        if discover(legacy) != [(legacy / "agents.md").resolve(strict=True)]:
            raise AssertionError("legacy pointer layout did not resolve lowercase authority")

        ambiguous = temp / "ambiguous"
        _write(ambiguous / "AGENTS.md", _full_policy("Upper authority"))
        _write(ambiguous / "agents.md", _full_policy("Lower authority"))
        _write_tool_pointers(ambiguous, MODERN_TOOL_POINTER)
        try:
            validate_layout(ambiguous)
        except DiscoveryError as error:
            if "ambiguous" not in str(error) and "independent" not in str(error):
                raise AssertionError("case-variant collision diagnostic is unclear") from error
        else:
            raise AssertionError("competing case-variant authorities were not rejected")

        missing_pointer = temp / "legacy-without-pointer"
        _write(missing_pointer / "agents.md", _full_policy("Legacy missing pointer"))
        _write_tool_pointers(missing_pointer, LEGACY_TOOL_POINTER)
        try:
            validate_layout(missing_pointer)
        except DiscoveryError as error:
            if "requires" not in str(error):
                raise AssertionError("missing legacy pointer diagnostic is unclear") from error
        else:
            raise AssertionError("lowercase-only legacy layout was accepted")

        broken_root = temp / "broken"
        broken_leaf = broken_root / "leaf"
        broken_leaf.mkdir(parents=True)
        (broken_root / "AGENTS.md").symlink_to(temp / "missing.md")
        try:
            discover(broken_leaf)
        except DiscoveryError as error:
            if "broken/AGENTS.md" not in str(error):
                raise AssertionError("broken-link diagnostic omitted the candidate") from error
        else:
            raise AssertionError("broken symlink was not reported")

        cycle_root = temp / "cycle"
        cycle_leaf = cycle_root / "leaf"
        cycle_leaf.mkdir(parents=True)
        (cycle_root / "AGENTS.md").symlink_to(cycle_root / "AGENTS.md")
        try:
            discover(cycle_leaf)
        except DiscoveryError as error:
            if "cycle/AGENTS.md" not in str(error):
                raise AssertionError("cycle diagnostic omitted the candidate") from error
        else:
            raise AssertionError("symlink cycle was not reported")

        unreadable_root = temp / "unreadable"
        unreadable_leaf = unreadable_root / "leaf"
        unreadable_leaf.mkdir(parents=True)
        unreadable = unreadable_root / "AGENTS.md"
        _write(unreadable, _full_policy("Unreadable"))
        unreadable.chmod(0)
        try:
            if os.name != "nt" and not os.access(unreadable, os.R_OK):
                try:
                    discover(unreadable_leaf)
                except DiscoveryError as error:
                    if "unreadable/AGENTS.md" not in str(error):
                        raise AssertionError("unreadable diagnostic omitted the candidate") from error
                else:
                    raise AssertionError("unreadable file was not reported")
            else:
                print("unreadable-file check skipped: current user can still read mode 000")
        finally:
            unreadable.chmod(0o600)

    print("AGENTS.md hierarchy migration self-test: PASS")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, help="repository root to validate")
    parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="discovery start path")
    parser.add_argument("--print-chain", action="store_true", help="print resolved files")
    parser.add_argument("--render", action="store_true", help="render merged instructions")
    parser.add_argument("--check-layout", action="store_true", help="validate repository pointers")
    parser.add_argument("--self-test", action="store_true", help="run hermetic discovery tests")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.check_layout:
            validate_layout(resolve_repository_root(args.repo_root))
            print("agent instruction layout: PASS")
        if args.self_test:
            self_test()
        if args.print_chain or args.render or (not args.check_layout and not args.self_test):
            chain = discover(args.cwd)
            if args.render:
                print(render(chain))
            else:
                for path in chain:
                    print(path)
    except (DiscoveryError, OSError, UnicodeError, AssertionError) as error:
        print(f"agents hierarchy error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
