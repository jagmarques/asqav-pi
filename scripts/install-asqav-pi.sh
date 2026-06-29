#!/bin/sh
# asqav Pi installer: upstream Pi + @asqav/pi global extension + fail-closed env.
# POSIX sh. Every mechanism is web-verified in docs/asqav-pi-distribution.md.
set -eu

# Source to install. Defaults to the npm package; pin to a version for a
# deterministic fleet, e.g. ASQAV_PI_SOURCE=npm:@asqav/pi@<version>, or use the
# git source ASQAV_PI_SOURCE=git:github.com/jagmarques/asqav-pi[@<tag-or-commit>].
ASQAV_PI_SOURCE="${ASQAV_PI_SOURCE:-npm:@asqav/pi}"
PI_NPM_PKG="@earendil-works/pi-coding-agent"
PI_HOME="${HOME}/.pi/agent"
ENV_FILE="${PI_HOME}/asqav-pi.env"
MARKER="# >>> asqav-pi >>>"
DRY_RUN=0

usage() {
  cat <<'EOF'
asqav Pi installer - upstream Pi + @asqav/pi global extension + fail-closed governance.

Usage:
  install-asqav-pi.sh [--dry-run] [--help]

Steps:
  1. Install upstream Pi (npm @earendil-works/pi-coding-agent) if `pi` is absent.
  2. Install @asqav/pi into Pi's GLOBAL package set (~/.pi/agent/settings.json), so
     its tool_call gate loads in every Pi process, including spawned sub-agents.
  3. Write a fail-closed env file (ASQAV_FAIL_CLOSED=true) and source it from your
     shell profile, so an unreachable asqav blocks the tool call, not runs ungoverned.

Env overrides:
  ASQAV_PI_SOURCE   @asqav/pi source (default npm:@asqav/pi). Pin with @<version>
                    (npm) or @<tag-or-commit> (git) for a deterministic install.
  ASQAV_API_KEY     Your asqav API key. Without it the extension fails closed and
                    blocks every tool call (set ASQAV_FAIL_OPEN=true to opt out).

Options:
  --dry-run   Print every action without running it.
  --help      Show this help.
EOF
}

say() { printf '%s\n' "$*"; }

# Run a command, or just print it under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) say "unknown option: $arg"; usage; exit 2 ;;
  esac
done

# Step 1: upstream Pi.
if have pi; then
  say "Pi present: $(pi --version 2>/dev/null || echo unknown)"
elif have npm; then
  say "Installing upstream Pi via npm..."
  run npm install -g --ignore-scripts "$PI_NPM_PKG"
else
  say "npm not found; installing upstream Pi via pi.dev/install.sh..."
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ %s\n' "curl -fsSL https://pi.dev/install.sh | sh"
  else
    curl -fsSL https://pi.dev/install.sh | sh
  fi
fi

# Step 2: @asqav/pi into the global package set so every process loads the gate.
say "Installing @asqav/pi globally from ${ASQAV_PI_SOURCE}..."
run pi install "$ASQAV_PI_SOURCE"

# Step 3: fail-closed env file plus a guarded source line in the shell profile.
say "Writing fail-closed env to ${ENV_FILE}..."
if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ write %s (ASQAV_FAIL_CLOSED=true)\n' "$ENV_FILE"
else
  mkdir -p "$PI_HOME"
  cat > "$ENV_FILE" <<'ENVEOF'
# Managed by the asqav Pi installer. Fail-closed governance for Pi.
# An unreachable asqav blocks the tool call instead of running ungoverned.
# A real policy deny blocks regardless of this flag.
export ASQAV_FAIL_CLOSED=true
ENVEOF
fi

# Pick a shell profile to source the env file from.
case "${SHELL:-}" in
  *zsh) PROFILE="${HOME}/.zshrc" ;;
  *bash) PROFILE="${HOME}/.bashrc" ;;
  *) PROFILE="${HOME}/.profile" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ ensure %s sources %s\n' "$PROFILE" "$ENV_FILE"
elif [ -f "$PROFILE" ] && grep -qF "$MARKER" "$PROFILE"; then
  say "Profile ${PROFILE} already wired."
else
  {
    printf '%s\n' "$MARKER"
    printf '%s\n' '[ -f "$HOME/.pi/agent/asqav-pi.env" ] && . "$HOME/.pi/agent/asqav-pi.env"'
    printf '%s\n' "# <<< asqav-pi <<<"
  } >> "$PROFILE"
  say "Wired ${PROFILE} to source ${ENV_FILE}."
fi

# Runtime key check: without it the extension fails closed and blocks every tool.
if [ -z "${ASQAV_API_KEY:-}" ]; then
  say ""
  say "WARNING: ASQAV_API_KEY is not set. Until you export it, @asqav/pi fails"
  say "closed and blocks every tool call. Set: export ASQAV_API_KEY=sk_..."
fi

say ""
say "Done. Open a new shell (or: . ${ENV_FILE}) and set ASQAV_API_KEY to govern Pi."
