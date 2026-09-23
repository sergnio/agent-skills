#!/usr/bin/env bash
# Verify gh is installed, new enough for --attach, and authenticated.
set -euo pipefail

min_major=2
min_minor=99

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

install_docs='https://github.com/cli/cli#installation'

command -v gh >/dev/null 2>&1 || fail "GitHub CLI (gh) is not installed. Install it: brew install gh, or see $install_docs"

version_line=$(gh --version | head -n 1)
[[ $version_line =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || fail "Could not parse gh version from: $version_line"
version=${BASH_REMATCH[0]}
major=${BASH_REMATCH[1]}
minor=${BASH_REMATCH[2]}

if ((major < min_major || (major == min_major && minor < min_minor))); then
  fail "gh $version is installed, but --attach needs gh $min_major.$min_minor.0 or newer. Upgrade it: brew upgrade gh, or see $install_docs"
fi

gh auth status >/dev/null 2>&1 || fail 'gh is not authenticated. Run: gh auth login'

printf 'gh %s is ready.\n' "$version"
