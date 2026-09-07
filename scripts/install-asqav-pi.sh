#!/bin/sh
# Install Pi and its Asqav extension with fail-closed startup.
set -eu

# Override the npm or Git source with ASQAV_PI_SOURCE.
ASQAV_PI_SOURCE="${ASQAV_PI_SOURCE:-git:github.com/jagmarques/asqav-pi}"
PI_NPM_PKG="@earendil-works/pi-coding-agent@0.85.1"
PI_HOME="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
ENV_FILE="${PI_HOME}/asqav-pi.env"
MARKER="# >>> asqav-pi >>>"
DRY_RUN=0

usage() {
  cat <<'EOF'
Asqav Pi installer - add an extension and configure signing failures to block.

Usage:
  install-asqav-pi.sh [--dry-run] [--help]

Steps:
  1. Install Pi 0.85.1 with npm if `pi` is absent. Requires Node.js 22.19+.
  2. Add @asqav/pi to Pi's global package configuration. Each process must load it.
  3. Write a fail-closed env file (ASQAV_FAIL_CLOSED=true) and source it from your
     shell profile. The setting applies when that environment file is sourced.

Env overrides:
  ASQAV_PI_SOURCE   Package source; default git:github.com/jagmarques/asqav-pi.
                    Append @<commit> to pin Git code, or supply a local directory.
  PI_CODING_AGENT_DIR  Pi configuration directory; default ~/.pi/agent.
  ASQAV_PI_PROFILE  Shell profile to edit; default follows $SHELL.
  ASQAV_API_KEY     Your Asqav API key. Without it the extension fails closed and
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

# Step 1: supported Node runtime and upstream Pi.
if ! have node || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  say "Node.js 22.19 or newer is required."
  exit 1
fi
if have pi; then
  say "Pi present: $(pi --version 2>/dev/null || echo unknown)"
elif have npm; then
  say "Installing upstream Pi via npm..."
  run npm install -g "$PI_NPM_PKG"
else
  say "npm is required to install Pi."
  exit 1
fi

# Step 2: add @asqav/pi to the selected Pi configuration directory.
say "Installing @asqav/pi globally from ${ASQAV_PI_SOURCE}..."
run pi install "$ASQAV_PI_SOURCE"

# Step 3: fail-closed env file plus a guarded source line in the shell profile.
say "Writing fail-closed env to ${ENV_FILE}..."
if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ write %s (ASQAV_FAIL_CLOSED=true)\n' "$ENV_FILE"
else
  mkdir -p "$PI_HOME"
  cat > "$ENV_FILE" <<'ENVEOF'
# Managed by Asqav Pi installer: signing errors block model tool calls
export ASQAV_FAIL_CLOSED=true
ENVEOF
fi

# Pick a shell profile to source the env file from.
case "${SHELL:-}" in
  *zsh) PROFILE="${HOME}/.zshrc" ;;
  *bash) PROFILE="${HOME}/.bashrc" ;;
  *) PROFILE="${HOME}/.profile" ;;
esac
PROFILE="${ASQAV_PI_PROFILE:-$PROFILE}"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '+ ensure %s sources %s\n' "$PROFILE" "$ENV_FILE"
elif [ -f "$PROFILE" ] && grep -qF "$MARKER" "$PROFILE"; then
  say "Profile ${PROFILE} already wired."
else
  {
    printf '%s\n' "$MARKER"
    printf '%s\n' '[ -f "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/asqav-pi.env" ] && . "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/asqav-pi.env"'
    printf '%s\n' "# <<< asqav-pi <<<"
  } >> "$PROFILE"
  say "Wired ${PROFILE} to source ${ENV_FILE}."
fi

# A missing API key blocks this process's model tool calls.
if [ -z "${ASQAV_API_KEY:-}" ]; then
  say ""
  say "WARNING: ASQAV_API_KEY is not set. Until you export it, @asqav/pi fails"
  say "closed and blocks every tool call. Set: export ASQAV_API_KEY=sk_..."
fi

say ""
say "Done. Open a new shell (or: . ${ENV_FILE}) and set ASQAV_API_KEY to govern Pi."
