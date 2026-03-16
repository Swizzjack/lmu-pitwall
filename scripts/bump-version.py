#!/usr/bin/env python3
"""
Bump the patch version across all project files.

Files updated:
  - VERSION               (single source of truth)
  - installer/lmu-pitwall-installer.iss  (#define MyAppVersion)
  - bridge/Cargo.toml     (version = "...")

Usage:
  python3 scripts/bump-version.py          # bump patch (1.0.1 → 1.0.2)
  python3 scripts/bump-version.py --minor  # bump minor (1.0.1 → 1.1.0)
  python3 scripts/bump-version.py --major  # bump major (1.0.1 → 2.0.0)
  python3 scripts/bump-version.py --show   # print current version, no change
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

def read_version() -> str:
    return (ROOT / "VERSION").read_text().strip()

def write_version(v: str):
    (ROOT / "VERSION").write_text(v + "\n")

def bump(version: str, part: str) -> str:
    major, minor, patch = map(int, version.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    elif part == "minor":
        return f"{major}.{minor + 1}.0"
    else:
        return f"{major}.{minor}.{patch + 1}"

def update_iss(new_version: str):
    path = ROOT / "installer" / "lmu-pitwall-installer.iss"
    content = path.read_text()
    content = re.sub(
        r'(#define MyAppVersion ")([^"]+)(")',
        f'\\g<1>{new_version}\\3',
        content,
    )
    path.write_text(content)

def update_cargo_toml(new_version: str):
    path = ROOT / "bridge" / "Cargo.toml"
    content = path.read_text()
    # Only replace the first occurrence (package version, not dependency versions)
    content = re.sub(
        r'^(version\s*=\s*")([^"]+)(")',
        f'\\g<1>{new_version}\\3',
        content,
        count=1,
        flags=re.MULTILINE,
    )
    path.write_text(content)

def update_package_json(new_version: str):
    path = ROOT / "dashboard" / "package.json"
    content = path.read_text()
    content = re.sub(
        r'("version"\s*:\s*")([^"]+)(")',
        f'\\g<1>{new_version}\\3',
        content,
        count=1,
    )
    path.write_text(content)

def main():
    part = "patch"
    for arg in sys.argv[1:]:
        if arg == "--major":
            part = "major"
        elif arg == "--minor":
            part = "minor"
        elif arg == "--show":
            print(read_version())
            return

    old = read_version()
    new = bump(old, part)

    write_version(new)
    update_iss(new)
    update_cargo_toml(new)
    update_package_json(new)

    print(f"Version bumped: {old} → {new}")

if __name__ == "__main__":
    main()
