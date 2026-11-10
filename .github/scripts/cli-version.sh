#!/usr/bin/env bash
# Next automatic release tag of the `share` CLI.
#
#   cli-version.sh <commit> [bump text file]
#
# Prints cli-v<x.y.z> for <commit>, or nothing when no release is necessary.
# The base is the newest stable tag cli-v<x.y.z> (tags with a "-" are
# prereleases and do not count). A release is necessary only when a CLI
# input changed between that tag and <commit>. The bump is patch; a line
# "cli: minor" or "cli: major" in the bump text (commit message, PR body)
# bumps that part instead. Needs the full history and the tags.
set -euo pipefail

# Files that go into the CLI binaries. cli/ imports only src/api-types.ts
# from the worker: check with git grep "from '../src" -- cli
INPUTS=(cli src/api-types.ts bun.lock)

commit=${1:?usage: cli-version.sh <commit> [bump text file]}
text=""
if [ -n "${2:-}" ]; then text=$(cat "$2"); fi

last=$(git tag -l 'cli-v*' --sort=-v:refname | grep -E '^cli-v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)
if [ -n "$last" ]; then
  if git diff --quiet "$last" "$commit" -- "${INPUTS[@]}"; then
    echo "no CLI change since $last" >&2
    exit 0
  fi
  IFS=. read -r major minor patch <<<"${last#cli-v}"
else
  major=0 minor=0 patch=0
fi

if grep -Eiq '^[[:space:]]*cli:[[:space:]]*major[[:space:]]*$' <<<"$text"; then
  major=$((major + 1)) minor=0 patch=0
elif grep -Eiq '^[[:space:]]*cli:[[:space:]]*minor[[:space:]]*$' <<<"$text"; then
  minor=$((minor + 1)) patch=0
else
  patch=$((patch + 1))
fi

tag="cli-v$major.$minor.$patch"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag exists already" >&2
  exit 0
fi
echo "$tag"
