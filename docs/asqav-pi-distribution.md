# asqav Pi - deterministic governed coding agent

asqav Pi is not a new agent and not a fork. It is upstream [Pi](https://pi.dev) plus
the `@asqav/pi` extension installed globally, run fail-closed. With that combination
every model tool call in every Pi process is signed and gated by asqav before it runs.

## Why this is a distribution, not a fork

Pi routes every model-decided action through one chokepoint. The model's only way to
cause a side effect is to emit a tool call, and Pi funnels all of them through
`tool_call` (which can block) before the tool executes. Built-in tools, extension
tools, and MCP-as-tools all share that single gate. There is no built-in MCP path and
no built-in sub-agent dispatch that sidesteps it. So an extension that hooks `tool_call`
governs the whole model surface, and forking the CLI buys nothing for enforcement.

A fork would also cost a perpetual rebase against a fast-moving pre-1.0 upstream, which
is off asqav's mission. The verified analysis is in the research notes referenced at the
end. The one requirement an extension cannot satisfy on its own is process coverage: a
spawned sub-agent is a separate `pi` process, so the extension must be installed
**globally** to load there too. That is exactly what this distribution sets up.

## Install

```bash
scripts/install-asqav-pi.sh
```

The script:

1. Installs upstream Pi (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`)
   if `pi` is not already on PATH.
2. Installs `@asqav/pi` into Pi's global package set with `pi install`, which by default
   writes to `~/.pi/agent/settings.json`. Pi discovers global extensions from
   `~/.pi/agent/extensions/`, so the gate loads in every Pi process, including spawned
   sub-agent processes.
3. Writes `~/.pi/agent/asqav-pi.env` with `ASQAV_FAIL_CLOSED=true` and sources it from
   your shell profile.

Run `scripts/install-asqav-pi.sh --dry-run` to print every action first, or `--help`
for options.

`@asqav/pi` is published to npm, so the default source is `npm:@asqav/pi`. For a
deterministic fleet, pin it to a version:

```bash
ASQAV_PI_SOURCE=npm:@asqav/pi@<version> scripts/install-asqav-pi.sh
```

The git source still works as an alternative
(`ASQAV_PI_SOURCE=git:github.com/jagmarques/asqav-pi@<tag-or-commit>`).

Then export your key and run Pi as usual:

```bash
export ASQAV_API_KEY=sk_...
pi
```

## Locking it per project

To pin the governance into a shared project, commit `.pi/settings.json`. Pi installs any
missing packages automatically on startup once the project is trusted.

```json
{
  "packages": [
    {
      "source": "npm:@asqav/pi",
      "extensions": ["extensions/*.ts"]
    }
  ]
}
```

Replace the source with `npm:@asqav/pi@<version>` to lock a version. A template ships at
the repo root in `.pi/settings.json`.

Note: Pi's `settings.json` has no field for environment variables, so the fail-closed env
(`ASQAV_FAIL_CLOSED=true`) is set in the shell profile by the install script, not in
`settings.json`.

## What `@asqav/pi` actually does today

The extension reads its configuration from the environment:

- `ASQAV_API_KEY` (required): the asqav API key. **Without it the extension fails closed
  by default and blocks every tool call** (set `ASQAV_FAIL_OPEN=true` to run ungoverned).
- `ASQAV_AGENT_NAME` (optional): the agent name on receipts, default `pi`.
- `ASQAV_OBSERVE_ONLY=true` (optional): sign every tool call, never block (only once init
  succeeds; an init failure still fails closed unless `ASQAV_FAIL_OPEN=true`).
- `ASQAV_FAIL_CLOSED=true` (optional): block the tool when signing is unreachable
  mid-session. That mid-session default is fail-open so a transient outage never breaks a
  working agent; init failure is a separate axis that fails closed by default. A real
  policy deny blocks regardless of this flag.
- `ASQAV_FAIL_OPEN=true` (or `ASQAV_FAIL_CLOSED=false`): deliberate opt-out that restores
  the old inactive/allow behavior when the extension cannot initialize.

The distribution sets `ASQAV_FAIL_CLOSED=true` to turn the unreachable case into a block.

## The one guarantee and its one caveat

Guarantee: with `ASQAV_API_KEY` set and `ASQAV_FAIL_CLOSED=true`, every model tool call
in every Pi process is signed before it runs, a policy deny blocks the tool, and an
unreachable asqav also blocks it. Because the install is global, the same holds inside
spawned sub-agent processes.

Caveat: the guarantee depends on the **global** install reaching every process. A
project-only install does not govern sub-agent processes that read global settings. A
missing `ASQAV_API_KEY` no longer disables the extension; by default it fails closed and
blocks every tool call (opt out with `ASQAV_FAIL_OPEN=true`).

## Fail-closed on init failure (shipped)

The extension is fail-closed by default when it cannot initialize: a missing
`ASQAV_API_KEY` or a failed agent startup blocks every tool call instead of running Pi
ungoverned. This is independent of the mid-session `ASQAV_FAIL_CLOSED` signing-transport
flag. Set `ASQAV_FAIL_OPEN=true` (or `ASQAV_FAIL_CLOSED=false`) to deliberately opt out
and restore the old inactive/allow behavior. Covered by `tests/init-failclosed.test.ts`.

## Sources

- Global extension discovery `~/.pi/agent/extensions/*.ts`: https://pi.dev/docs/latest/extensions
- Global vs project install, `pi install`, auto-install on trust, `packages` schema: https://pi.dev/docs/latest/packages
- `settings.json` top-level fields (no `env` field): https://pi.dev/docs/latest/settings
- Upstream Pi install command and `~/.pi/agent/` layout: https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md
- tool_call single-gate determinism analysis: `.company/research/pi-toolcall-coverage.md` and `.company/research/asqav-pi-fork-vs-extension.md`
- Env vars honored by the extension: `extensions/asqav.ts` (the `asqavExtension` default export)
