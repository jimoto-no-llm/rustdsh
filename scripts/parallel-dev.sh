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
#   port <slug>     port for a slug (the assigned one, once the worktree exists)
#   status          ahead/behind, dirty state and conflict state per worktree
#
# Layout, relative to the parent of this repository:
#
#   <parent>/.worktrees/.worktrees.git   local object store (fetch/borrow source)
#   <parent>/.worktrees/.git             bare mirror used to seed new worktrees
#   <parent>/.worktrees/rustdsh-<slug>   the worktree itself
#
# Ports come from RDSH_PARALLEL_PORT_BASE (default 49000), hashed from the
# slug. When another managed worktree already holds that port, new walks
# forward to the next free one and records the result in the worktree's admin
# dir, so an assignment stays stable for the life of the worktree.
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
  port <slug>           print the port for a slug
  status [--no-fetch]   ahead/behind, dirty and conflict state per worktree
  help                  show this message

Environment:
  RDSH_PARALLEL_PORT_BASE   first port of the range (default 49000, max 64536)
  RDSH_PARALLEL_BASE_REF    base ref for `new`/`status` (default <remote>/main)
  RDSH_PARALLEL_REMOTE      remote for new and status (default origin)
USAGE
}

# The canonical checkout this script was started from: the repository-level
# reads (remote URL and object-store seeding) need a
# real checkout. The shared worktrees root is derived separately below.
repo_root() {
  git rev-parse --show-toplevel 2>/dev/null ||
    die "not inside a Git repository"
}

# Absolute, symlink-resolved common Git dir of the repository containing $1.
common_git_dir_real() {
  local dir="$1" common
  common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" || return 1
  case "$common" in
    /*|[A-Za-z]:/*) ;;
    *) common="$(cd "$dir" && pwd -P)/$common" ;;
  esac
  (cd "$common" 2>/dev/null && pwd -P)
}

# The shared <parent>/.worktrees root: ~/ghq/github.com/owner/.worktrees for
# ~/ghq/github.com/owner/repo. Derived from the *common* Git dir so a run from
# inside a managed worktree resolves the same root. `--show-toplevel` cannot do
# that: it answers with the worktree itself and nests .worktrees/.worktrees.
worktrees_root() {
  local common parent
  common="$(common_git_dir_real "$(pwd -P)" 2>/dev/null || printf '')"
  [ -n "$common" ] || die "not inside a Git repository"
  parent="$(dirname "$common")"
  if [ "$(basename "$parent")" = ".worktrees" ]; then
    # The common dir is the bare mirror at <parent>/.worktrees/.git.
    printf '%s\n' "$parent"
  else
    printf '%s/.worktrees\n' "$(dirname "$parent")"
  fi
}

port_base() {
  local base="${RDSH_PARALLEL_PORT_BASE:-$PORT_BASE_DEFAULT}" max_base
  max_base=$((65535 - PORT_RANGE + 1))
  case "$base" in
    ''|*[!0-9]*) die "RDSH_PARALLEL_PORT_BASE must be a number, got '$base'" ;;
  esac
  # Shell arithmetic interprets a leading zero as octal. Normalize decimal
  # input first, then bound its length before any numeric comparison so a
  # huge integer cannot overflow or make `test` fail open.
  base="${base#"${base%%[!0]*}"}"
  base="${base:-0}"
  if [ "${#base}" -gt 5 ] || [ "$base" -lt 1024 ] || [ "$base" -gt "$max_base" ]; then
    die "RDSH_PARALLEL_PORT_BASE must be between 1024 and $max_base (base + $((PORT_RANGE - 1)) must stay <= 65535), got '$base'"
  fi
  printf '%s\n' "$base"
}

# Deterministic: the first four bytes of sha256("rustdsh-parallel/<slug>"),
# modulo the range size. The prefix keeps the mapping stable if the same slug
# is reused for a different project sharing RDSH_PARALLEL_PORT_BASE.
port_index_for() {
  local slug="$1" digest hashcmd
  if command -v sha256sum >/dev/null 2>&1; then
    hashcmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    hashcmd="shasum -a 256"
  else
    die "need sha256sum or shasum to derive the port"
  fi
  digest="$(printf 'rustdsh-parallel/%s' "$slug" | $hashcmd | cut -c1-8)"
  printf '%s\n' "$((0x$digest % PORT_RANGE))"
}

port_from_index() {
  local base
  # Capture through a variable: a die inside `$(port_base)` would otherwise be
  # swallowed by the surrounding command substitution and only print.
  base="$(port_base)" || return 1
  printf '%s\n' "$(( $1 + base ))"
}

port_for() {
  local index
  index="$(port_index_for "$1")" || return 1
  port_from_index "$index"
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
    /*|[A-Za-z]:/*) ;;
    *) gitdir="$(cd "$dir" && pwd -P)/$gitdir" ;;
  esac
  (cd "$gitdir" 2>/dev/null && pwd -P)
}

# Require both directions of the linked-worktree registration. A copied .git
# pointer alone must not let an ordinary sibling directory impersonate an owned
# worktree. Reading the admin backlink also works when HEAD/status is broken.
is_mirror_worktree() {
  local dir="$1" mirror_real="$2" pointer gitdir backlink expected
  [ -f "$dir/.git" ] || return 1
  pointer="$(sed -n 's/^gitdir: //p' "$dir/.git" 2>/dev/null)" || return 1
  [ -n "$pointer" ] || return 1
  case "$pointer" in
    /*|[A-Za-z]:/*) ;;
    *) pointer="$(cd "$dir" && pwd -P)/$pointer" ;;
  esac
  gitdir="$(cd "$pointer" 2>/dev/null && pwd -P)" || return 1
  [ "$(dirname "$gitdir")" = "$mirror_real/worktrees" ] || return 1
  backlink="$(cat "$gitdir/gitdir" 2>/dev/null)" || return 1
  case "$backlink" in
    /*|[A-Za-z]:/*) ;;
    *) backlink="$gitdir/$backlink" ;;
  esac
  backlink="$(cd "$(dirname "$backlink")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$backlink")")" || return 1
  expected="$(cd "$dir" && pwd -P)/.git"
  [ "$backlink" = "$expected" ]
}

# `new` records the port it assigned here (the worktree's admin dir, never
# the working tree), so a port shifted away from a collision stays stable and
# `list` reports the port that is really in use.
port_record_path() {
  local gitdir
  gitdir="$(worktree_gitdir "$1")" || return 1
  printf '%s/rdsh-parallel-port\n' "$gitdir"
}

assigned_port() {
  local slug="$1" record value
  record="$(port_record_path "$(worktree_path "$slug")" 2>/dev/null || printf '')"
  if [ -n "$record" ] && [ -f "$record" ]; then
    value="$(tr -d '[:space:]' <"$record")"
    case "$value" in
      ''|*[!0-9]*) ;;
      *) printf '%s\n' "$value"; return 0 ;;
    esac
  fi
  port_for "$slug"
}

record_port() {
  local dir="$1" port="$2" record
  record="$(port_record_path "$dir")" || return 1
  printf '%s\n' "$port" >"$record"
}

# Ports already held by managed worktrees other than $1.
taken_ports() {
  local skip="$1" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ "${name#rustdsh-}" = "$skip" ]; then
      continue
    fi
    assigned_port "${name#rustdsh-}"
  done < <(managed_worktrees)
}

# The first free port at or after the slug's hash position, wrapping once
# around the range, so two slugs that hash to the same port never share one.
free_port_for() {
  local slug="$1" taken index candidate offset port
  taken=" $(taken_ports "$slug" | tr '\n' ' ')"
  index="$(port_index_for "$slug")"
  offset=0
  while [ "$offset" -lt "$PORT_RANGE" ]; do
    candidate=$(( (index + offset) % PORT_RANGE ))
    port="$(port_from_index "$candidate")"
    case "$taken" in
      *" $port "*) ;;
      *) printf '%s\n' "$port"; return 0 ;;
    esac
    offset=$((offset + 1))
  done
  die "no free port in $(( $(port_base) ))-$(( $(port_base) + PORT_RANGE - 1 )): every slot is held by a managed worktree"
}

# Port selection and recording must be one operation: two simultaneous new
# commands otherwise both see the other's unrecorded hash and pick the same
# next port. mkdir is atomic on the supported shells, without another runtime.
reserve_port() (
  local slug="$1" dir="$2" lock tries=0 port
  lock="$(worktrees_root)/.rdsh-port-allocation.lock"
  while ! mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 100 ] || die "port allocation is busy at $lock; no port was assigned"
    sleep .05
  done
  trap 'rmdir "$lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  port="$(free_port_for "$slug")" || exit 1
  record_port "$dir" "$port" || die "could not record the port of $dir"
  printf '%s\n' "$port"
)

# Make the worktree borrow loose objects from the shared local object store.
# The alternates file lives next to the *common* object database, which is what
# `--git-path` resolves; the per-worktree git dir has no objects of its own, so
# writing there would be ignored. The file is seed-only: after the first fetch
# it only ever holds extra loose objects, so a garbage-collected canonical repo
# cannot corrupt it.
point_at_object_store() {
  local dir="$1" store="$2" alternates
  # The file is read by Git, so keep Git's native absolute spelling (C:/...
  # on Git for Windows), rather than recording a shell-only /c/... alias.
  store="$(git -C "$store" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  alternates="$(git -C "$dir" rev-parse --git-path objects/info/alternates 2>/dev/null)" || {
    printf 'warning: cannot resolve the git dir of %s\n' "$dir" >&2
    return 1
  }
  case "$alternates" in
    /*|[A-Za-z]:/*) ;;
    *) alternates="$(cd "$dir" && pwd -P)/$alternates" ;;
  esac
  mkdir -p "$(dirname "$alternates")"
  if [ -f "$alternates" ]; then
    grep -qxF "$store/objects" "$alternates" ||
      printf '%s\n' "$store/objects" >>"$alternates"
  else
    printf '%s\n' "$store/objects" >"$alternates"
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
  # The remote decides the default base ref: RDSH_PARALLEL_REMOTE=upstream must
  # base the worktree on upstream/main, not on a hard-coded origin/main.
  remote="${RDSH_PARALLEL_REMOTE:-origin}"
  ref="${RDSH_PARALLEL_BASE_REF:-$remote/main}"
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
  port="$(reserve_port "$slug" "$dir")"
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
    port="$(assigned_port "${name#rustdsh-}")"
    printf '%-28s %-26s %-10s %s\n' "$name" "$branch" "$sha" "$port"
  done < <(managed_worktrees)
}

cmd_port() {
  local slug="${1:-}"
  validate_slug "$slug"
  assigned_port "$slug"
}

cmd_remove() {
  local force=0 slug="" dir branch resolved mirror mirror_real common status_out unpublished
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
  mirror="$(mirror_path)" || exit 1
  mirror_real="$(cd "$mirror" 2>/dev/null && pwd -P || printf '%s' "$mirror")"
  is_mirror_worktree "$resolved" "$mirror_real" ||
    die "refusing to delete $resolved: it is not a worktree of $mirror"
  common="$(common_git_dir_real "$resolved" 2>/dev/null || printf '')"
  [ -z "$common" ] || [ "$common" = "$mirror_real" ] ||
    die "refusing to delete $resolved: it belongs to another repository"
  branch="$(git -C "$resolved" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '')"

  # A failing `git status` means "not a usable worktree", never "clean": a plain
  # directory that happens to be named rustdsh-<slug> must not be mistaken for
  # a clean worktree and deleted. Without --force that is fatal; with --force
  # the mirror-ownership proof below still has to pass before anything is
  # deleted, so a broken worktree stays removable.
  if ! status_out="$(git -C "$resolved" status --porcelain 2>&1)"; then
    if [ "$force" -ne 1 ]; then
      die "cannot read the Git status of $resolved: $status_out"
    fi
    printf 'note: cannot read the Git status of %s: %s\n' "$resolved" "$status_out" >&2
  elif [ "$force" -ne 1 ] && [ -n "$status_out" ]; then
    printf 'error: %s has uncommitted changes:\n' "$resolved" >&2
    printf '%s\n' "$status_out" >&2
    die "commit, stash or discard them, or re-run with --force"
  fi

  # Check HEAD, including a detached HEAD, before removing its last checkout.
  # An inspection error is not evidence that every commit is on a remote.
  if [ "$force" -ne 1 ]; then
    unpublished="$(git -C "$resolved" rev-list --max-count=1 HEAD --not --remotes 2>&1)" ||
      die "cannot check unpublished commits in $resolved: $unpublished"
    [ -z "$unpublished" ] ||
      die "$resolved has commits that are not on any remote; push them or re-run with --force"
  fi

  # `git worktree remove` deletes the directory and prunes the mirror's admin
  # files. The rm is the fallback for a worktree that is already broken; it
  # requires --force *and* proof that the directory belongs to the mirror, so
  # an unrelated directory that shares the name is never deleted.
  local -a remove_args=("$resolved")
  [ "$force" -ne 1 ] || remove_args=(--force "$resolved")
  if ! git -C "$mirror" worktree remove "${remove_args[@]}" 2>/dev/null; then
    if [ "$force" -ne 1 ]; then
      die "git worktree remove failed for $resolved; re-run with --force to delete it directly"
    fi
    is_mirror_worktree "$resolved" "$mirror_real" ||
      die "refusing to delete $resolved: it is not a worktree of $mirror"
    printf 'note: git worktree remove failed; deleting %s directly\n' "$resolved" >&2
    rm -rf -- "$resolved"
  fi
  git -C "$mirror" worktree prune >/dev/null 2>&1 || true

  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    if git -C "$mirror" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$mirror" branch -D "$branch" >/dev/null 2>&1 ||
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
  local fetch=1 fetch_err="" remote mirror status_output status_failed=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-fetch) fetch=0 ;;
      -*) die "unknown option '$1'" ;;
      *) die "unexpected argument '$1'" ;;
    esac
    shift
  done
  remote="${RDSH_PARALLEL_REMOTE:-origin}"
  base="${RDSH_PARALLEL_BASE_REF:-$remote/main}"
  mirror="$(mirror_path)" || exit 1
  # AHEAD/BEHIND is only as fresh as the last fetch, so fetch the shared mirror
  # here instead of reporting whatever it happened to hold.
  if [ "$fetch" -eq 1 ]; then
    if [ ! -d "$mirror" ]; then
      printf 'note: no shared mirror at %s yet; AHEAD/BEHIND may be stale\n' "$mirror" >&2
    elif fetch_err="$(git -C "$mirror" fetch --prune --quiet "$remote" \
      "+refs/heads/*:refs/remotes/$remote/*" 2>&1)"; then
      printf 'fetched %s in %s\n' "$remote" "$mirror" >&2
    else
      printf 'warning: fetch failed in %s; AHEAD/BEHIND may be stale\n%s\n' \
        "$mirror" "$fetch_err" >&2
    fi
  else
    printf 'note: --no-fetch: AHEAD/BEHIND is as of the last fetch and may be stale\n' >&2
  fi
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
    if status_output="$(git -C "$dir" status --porcelain)"; then
      if [ -n "$status_output" ]; then dirty="dirty"; else dirty="clean"; fi
    else
      dirty="unknown"
      status_failed=1
      printf 'warning: cannot read Git status for %s; DIRTY is unknown\n' "$dir" >&2
    fi
    printf '%-26s %-22s %-10s %-13s %-9s %s\n' \
      "$name" "$branch" "$sha" "+$ahead/-$behind" "$dirty" "$conflicts"
  done < <(managed_worktrees)
  return "$status_failed"
}

main() {
  local cmd="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    # port_base runs in this shell for the commands that use ports, so an
    # invalid RDSH_PARALLEL_PORT_BASE is a hard error and not a printed note
    # that a nested command substitution swallows.
    new) [ $# -ge 1 ] || die "new needs a slug"; port_base >/dev/null; cmd_new "$@" ;;
    list) port_base >/dev/null; cmd_list ;;
    remove) [ $# -ge 1 ] || die "remove needs a slug"; cmd_remove "$@" ;;
    port) [ $# -ge 1 ] || die "port needs a slug"; port_base >/dev/null; cmd_port "$@" ;;
    status) port_base >/dev/null; cmd_status "$@" ;;
    help|-h|--help) usage ;;
    *) usage >&2; die "unknown command '$cmd'" ;;
  esac
}

main "$@"
