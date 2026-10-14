#!/usr/bin/env bash
# parallel-dev.sh: isolated worktrees for parallel rustdsh work.
#
# Every parallel topic gets its own worktree *and* its own Git repository, so
# nothing here needs `git worktree add` in the canonical checkout. That keeps
# the primary repo's worktree list (and its index) untouched, and it keeps each
# branch in exactly one checkout. See docs/PARALLEL-DEV.md.
#
#   new <slug>      create .worktrees/rustdsh-<slug> on branch parallel/<slug>
#   list            managed worktrees with branch, HEAD sha and port
#   remove <slug>   remove a worktree and its branch (--force to override)
#   port <slug>     deterministic port for a slug
#   status          ahead/behind, dirty state and conflict state per worktree
#
# Layout, relative to the parent of this repository:
#
#   <parent>/.worktrees/.worktrees.git   local object store (fetch/borrow source)
#   <parent>/.worktrees/.git             bare mirror used to seed new worktrees
#   <parent>/.worktrees/rustdsh-<slug>   the worktree itself
#
# Ports come from RDSH_PARALLEL_PORT_BASE (default 49000), hashed from the
# slug, so two topics never pick the same dashboard/dev port by accident.
set -euo pipefail

readonly PORT_BASE_DEFAULT=49000
readonly PORT_RANGE=1000

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage: scripts/parallel-dev.sh <command> [options]

  new <slug>            create a parallel worktree on a new branch
  list                  list managed parallel worktrees
  remove <slug>         remove a worktree and its branch
                        (--force also discards uncommitted changes)
  port <slug>           print the deterministic port for a slug
  status                ahead/behind, dirty and conflict state per worktree
  help                  show this message

Environment:
  RDSH_PARALLEL_PORT_BASE   first port of the range (default 49000)
  RDSH_PARALLEL_BASE_REF    base ref for `new` (default origin/main)
  RDSH_PARALLEL_REMOTE      remote for `new` and `status` (default origin)
USAGE
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null ||
    die "not inside a Git repository"
}

# The parent directory of the repository: ~/ghq for ~/ghq/github.com/owner/repo.
worktrees_root() {
  local root
  root="$(repo_root)" || exit 1
  printf '%s/.worktrees\n' "$(dirname "$root")"
}

port_base() {
  local base="${RDSH_PARALLEL_PORT_BASE:-$PORT_BASE_DEFAULT}"
  case "$base" in
    ''|*[!0-9]*) die "RDSH_PARALLEL_PORT_BASE must be a number, got '$base'" ;;
  esac
  if [ "$base" -lt 1024 ] || [ "$base" -gt 65000 ]; then
    die "RDSH_PARALLEL_PORT_BASE must be between 1024 and 65000, got '$base'"
  fi
  printf '%s\n' "$base"
}

# Deterministic: the first four bytes of sha256("rustdsh-parallel/<slug>"),
# modulo the range size. The prefix keeps the mapping stable if the same slug
# is reused for a different project sharing RDSH_PARALLEL_PORT_BASE.
port_for() {
  local slug="$1" digest index hashcmd
  if command -v sha256sum >/dev/null 2>&1; then
    hashcmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    hashcmd="shasum -a 256"
  else
    die "need sha256sum or shasum to derive the port"
  fi
  digest="$(printf 'rustdsh-parallel/%s' "$slug" | $hashcmd | cut -c1-8)"
  index=$((0x$digest % PORT_RANGE))
  printf '%s\n' "$((index + $(port_base)))"
}

validate_slug() {
  local slug="${1:-}"
  case "$slug" in
    '') die "missing slug (lowercase letters, digits and dashes)" ;;
  esac
  case "$slug" in
    *[!a-z0-9-]*|[-]*) die "invalid slug '$slug': use [a-z0-9-], not starting with '-'" ;;
  esac
  case "$slug" in
    *--*) die "invalid slug '$slug': consecutive dashes are not allowed" ;;
  esac
}

worktree_path() { printf '%s/rustdsh-%s\n' "$(worktrees_root)" "$1"; }
branch_for() { printf 'parallel/%s\n' "$1"; }
object_store() { printf '%s/.worktrees.git\n' "$(worktrees_root)"; }
mirror_path() { printf '%s/.git\n' "$(worktrees_root)"; }

# Fail before any rm reaches a path we did not compute ourselves: it must sit
# directly under the worktrees root, be named rustdsh-<slug>, and never be the
# repository (or a parent of it). Every deletion path goes through this.
verify_removable_path() {
  local slug="$1" expected resolved parent root real_root repo real_repo
  expected="$(worktree_path "$slug")" || exit 1
  root="$(worktrees_root)" || exit 1
  [ -e "$expected" ] || die "no worktree for '$slug' at $expected"
  resolved="$(cd "$expected" 2>/dev/null && pwd -P)" ||
    die "cannot resolve $expected"
  real_root="$(cd "$root" && pwd -P)" || die "cannot resolve $root"
  parent="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd -P)" ||
    die "cannot resolve the parent of $resolved"
  [ "$parent" = "$real_root" ] ||
    die "refusing to remove $resolved: not directly inside $real_root"
  [ "$(basename "$resolved")" = "rustdsh-$slug" ] ||
    die "refusing to remove $resolved: unexpected name"
  repo="$(repo_root)" && real_repo="$(cd "$repo" && pwd -P)"
  case "$resolved" in
    "$real_repo"|"$real_repo"/*)
      die "refusing to remove $resolved: that is inside the repository itself" ;;
  esac
  [ "$resolved" != "/" ] || die "refusing to remove /"
  printf '%s\n' "$resolved"
}

managed_worktrees() {
  local root dir
  root="$(worktrees_root)" || return 1
  [ -d "$root" ] || return 0
  for dir in "$root"/rustdsh-*; do
    [ -e "$dir/.git" ] || continue
    [ -d "$dir" ] || continue
    basename "$dir"
  done
}

# .worktrees/<name>/.git is a *file* for a linked worktree, so ask Git where the
# per-worktree gitdir really is instead of guessing "$dir/.git".
worktree_gitdir() {
  local dir="$1" gitdir
  gitdir="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  case "$gitdir" in
    /*) printf '%s\n' "$gitdir" ;;
    *) printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$gitdir" ;;
  esac
}

# Make the worktree borrow loose objects from the shared local object store.
# The alternates file is seed-only: after the first fetch it only ever holds
# extra loose objects, so a garbage-collected canonical repo cannot corrupt it.
point_at_object_store() {
  local dir="$1" store="$2" gitdir
  gitdir="$(worktree_gitdir "$dir")" || {
    printf 'warning: cannot resolve the git dir of %s\n' "$dir" >&2
    return 1
  }
  mkdir -p "$gitdir/objects/info"
  if [ -f "$gitdir/objects/info/alternates" ]; then
    grep -qxF "$store/objects" "$gitdir/objects/info/alternates" ||
      printf '%s\n' "$store/objects" >>"$gitdir/objects/info/alternates"
  else
    printf '%s\n' "$store/objects" >"$gitdir/objects/info/alternates"
  fi
}

ensure_mirror() {
  local mirror remote url
  mirror="$(mirror_path)" || exit 1
  remote="${RDSH_PARALLEL_REMOTE:-origin}"
  if [ ! -d "$mirror" ]; then
    command -v git >/dev/null 2>&1 || die "git not found"
    # Resolve the URL here: a bare repository cannot resolve a remote *name*.
    url="$(git -C "$(repo_root)" remote get-url "$remote" 2>/dev/null)" ||
      die "this repository has no remote '$remote' (see RDSH_PARALLEL_REMOTE)"
    printf 'creating shared mirror %s\n' "$mirror" >&2
    git clone --bare "$url" "$mirror" >/dev/null 2>&1 ||
      die "cannot clone '$url' into $mirror (is the remote reachable?)"
    git -C "$mirror" remote rename origin "$remote" >/dev/null 2>&1 || true
  fi
  git -C "$mirror" remote get-url "$remote" >/dev/null 2>&1 ||
    die "mirror $mirror has no remote '$remote' (RDSH_PARALLEL_REMOTE)"
}

ensure_object_store() {
  local store
  store="$(object_store)" || exit 1
  [ -d "$store" ] && return 0
  printf 'creating local object store %s from %s\n' "$store" "$(repo_root)" >&2
  git clone --bare --shared "$(repo_root)" "$store" >/dev/null 2>&1 ||
    die "cannot create the object store at $store"
}

cmd_new() {
  local slug="${1:-}" ref remote dir mirror root base_sha head_sha port
  validate_slug "$slug"
  ref="${RDSH_PARALLEL_BASE_REF:-origin/main}"
  remote="${RDSH_PARALLEL_REMOTE:-origin}"
  root="$(worktrees_root)" || exit 1
  dir="$(worktree_path "$slug")" || exit 1

  [ -e "$dir" ] && die "already exists: $dir (use 'remove $slug' first)"
  git show-ref --verify --quiet "refs/heads/$(branch_for "$slug")" &&
    die "branch $(branch_for "$slug") already exists in $(repo_root)"

  mkdir -p "$root"
  ensure_object_store
  ensure_mirror

  mirror="$(mirror_path)" || exit 1
  printf 'fetching %s in %s\n' "$remote" "$mirror" >&2
  git -C "$mirror" fetch --prune --quiet "$remote" "+refs/heads/*:refs/remotes/$remote/*" ||
    die "fetch failed in $mirror"

  git -C "$mirror" rev-parse --verify --quiet "refs/remotes/$ref" >/dev/null ||
    die "base ref '$ref' does not exist (try RDSH_PARALLEL_BASE_REF=main)"
  base_sha="$(git -C "$mirror" rev-parse "refs/remotes/$ref")"

  git -C "$mirror" worktree add --quiet --no-checkout -b "$(branch_for "$slug")" \
    "$dir" "refs/remotes/$ref" ||
    die "git worktree add failed for $dir"
  git -C "$dir" read-tree --reset -u HEAD ||
    die "cannot check out $base_sha into $dir"

  point_at_object_store "$dir" "$(object_store)" || true
  git -C "$dir" fetch --quiet "$remote" "+refs/heads/*:refs/remotes/$remote/*" ||
    printf 'warning: fetch in %s failed; retry with git fetch %s\n' "$dir" "$remote" >&2

  head_sha="$(git -C "$dir" rev-parse HEAD)"
  port="$(port_for "$slug")"
  printf 'created %s\n' "$dir"
  printf 'branch  %s (from %s at %s)\n' \
    "$(branch_for "$slug")" "$ref" "$(printf '%s' "$head_sha" | cut -c1-8)"
  printf 'port    %s\n' "$port"
  printf 'next    cd %s\n' "$dir"
}

cmd_list() {
  local name dir branch sha port
  printf '%-28s %-26s %-10s %s\n' "WORKTREE" "BRANCH" "HEAD" "PORT"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    dir="$(worktrees_root)/$name"
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?')"
    sha="$(git -C "$dir" rev-parse --short=8 HEAD 2>/dev/null || printf '?')"
    port="$(port_for "${name#rustdsh-}")"
    printf '%-28s %-26s %-10s %s\n' "$name" "$branch" "$sha" "$port"
  done < <(managed_worktrees)
}

cmd_port() {
  local slug="${1:-}"
  validate_slug "$slug"
  port_for "$slug"
}

cmd_remove() {
  local force=0 slug="" dir branch resolved
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f) force=1 ;;
      -*) die "unknown option '$1'" ;;
      *) [ -n "$slug" ] && die "unexpected argument '$1'"; slug="$1" ;;
    esac
    shift
  done
  validate_slug "$slug"
  dir="$(worktree_path "$slug")" || exit 1
  [ -d "$dir" ] || die "no worktree for '$slug' at $dir"
  resolved="$(verify_removable_path "$slug")" || exit 1
  branch="$(git -C "$resolved" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '')"

  if [ "$force" -ne 1 ]; then
    if [ -n "$(git -C "$resolved" status --porcelain 2>/dev/null)" ]; then
      printf 'error: %s has uncommitted changes:\n' "$resolved" >&2
      git -C "$resolved" status --short >&2
      die "commit, stash or discard them, or re-run with --force"
    fi
  fi

  # `git worktree remove` deletes the directory and prunes the mirror's admin
  # files. The rm is the fallback for a worktree that is already broken, and it
  # only ever sees the path verify_removable_path accepted.
  if ! git -C "$(mirror_path)" worktree remove --force "$resolved" 2>/dev/null; then
    printf 'note: git worktree remove failed; deleting %s directly\n' "$resolved" >&2
    rm -rf -- "$resolved"
  fi
  git -C "$(mirror_path)" worktree prune >/dev/null 2>&1 || true

  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    if git -C "$(repo_root)" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$(repo_root)" branch -D "$branch" >/dev/null 2>&1 ||
        printf 'warning: could not delete local branch %s\n' "$branch" >&2
    elif git -C "$(mirror_path)" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$(mirror_path)" branch -D "$branch" >/dev/null 2>&1 ||
        printf 'warning: could not delete branch %s in the mirror\n' "$branch" >&2
    fi
    printf 'deleted branch %s\n' "$branch"
  fi
  printf 'removed %s\n' "$resolved"
}

# Conflict detection that never touches a working tree or an index: ask
# `git merge-tree --write-tree` for the merged tree between the worktree HEAD
# and the remote-tracking base. Exit 0 means the merge is clean, exit 1 with a
# CONFLICT line means it is not. `merge-tree` keeps its progress messages on
# stdout regardless of --messages, so classify on exit code first and only scan
# the captured output to tell a real conflict from any other failure.
conflict_state() {
  local dir="$1" base="$2" base_sha head output rc
  base_sha="$(git -C "$dir" rev-parse --verify --quiet "$base")" || { printf 'unknown'; return 0; }
  head="$(git -C "$dir" rev-parse HEAD)" || { printf 'unknown'; return 0; }
  output="$(git -C "$dir" merge-tree --write-tree --messages "$base_sha" "$head" 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'clean'
  elif [ "$rc" -eq 1 ] && printf '%s\n' "$output" | grep -q '^CONFLICT'; then
    printf 'conflicts'
  else
    printf 'unknown'
  fi
  return 0
}

cmd_status() {
  local name dir branch sha base counts ahead behind dirty conflicts
  base="${RDSH_PARALLEL_REMOTE:-origin}/main"
  printf '%-26s %-22s %-10s %-13s %-9s %s\n' \
    "WORKTREE" "BRANCH" "HEAD" "AHEAD/BEHIND" "DIRTY" "VS $base"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    dir="$(worktrees_root)/$name"
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?')"
    sha="$(git -C "$dir" rev-parse --short=8 HEAD 2>/dev/null || printf '?')"
    if git -C "$dir" rev-parse --verify --quiet "$base" >/dev/null; then
      counts="$(git -C "$dir" rev-list --left-right --count "$base...HEAD" 2>/dev/null || printf '?\t?')"
      behind="${counts%%[[:space:]]*}"
      ahead="${counts##*[[:space:]]}"
      conflicts="$(conflict_state "$dir" "$base")"
    else
      ahead="?"; behind="?"; conflicts="unknown"
    fi
    if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
      dirty="dirty"
    else
      dirty="clean"
    fi
    printf '%-26s %-22s %-10s %-13s %-9s %s\n' \
      "$name" "$branch" "$sha" "+$ahead/-$behind" "$dirty" "$conflicts"
  done < <(managed_worktrees)
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    new) [ $# -ge 1 ] || die "new needs a slug"; cmd_new "$@" ;;
    list) cmd_list ;;
    remove) [ $# -ge 1 ] || die "remove needs a slug"; cmd_remove "$@" ;;
    port) [ $# -ge 1 ] || die "port needs a slug"; cmd_port "$@" ;;
    status) cmd_status ;;
    help|-h|--help) usage ;;
    *) usage >&2; die "unknown command '$cmd'" ;;
  esac
}

main "$@"
