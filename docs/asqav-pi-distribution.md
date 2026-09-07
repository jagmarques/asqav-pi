# Install Asqav in Pi

The installer adds the Asqav extension to Pi's global package configuration and
writes a shell environment file with `ASQAV_FAIL_CLOSED=true`. Review its actions:

```bash
scripts/install-asqav-pi.sh --dry-run
scripts/install-asqav-pi.sh
```

Use Node.js 22.19 or newer. If Pi is absent, the installer installs Pi 0.85.1 with npm.
Its default extension source is `git:github.com/jagmarques/asqav-pi`. Pin a revision
by setting `ASQAV_PI_SOURCE=git:github.com/jagmarques/asqav-pi@<commit>`.
A local absolute directory is also supported.

By default the script writes `~/.pi/agent/asqav-pi.env` and adds a source line to
`.zshrc`, `.bashrc` or `.profile`, according to `$SHELL`. `PI_CODING_AGENT_DIR` changes
the Pi configuration directory. `ASQAV_PI_PROFILE` selects a shell profile explicitly.
The script does not write an API key. Open a new shell, then configure one:

```bash
export ASQAV_API_KEY=your-api-key
export ASQAV_MODE=hash-only
pi
```

The environment file sets the signing-error behavior. A separate startup default
blocks model tool calls when the extension cannot initialize, including a missing
key. `ASQAV_FAIL_OPEN=true` or `ASQAV_FAIL_CLOSED=false` opts out of that startup
block. Observation mode allows policy refusals but still follows the signing-error
setting. See the [decision table and data handling](../README.md).

## Project configuration

Pi supports project package configuration in `.pi/settings.json`:

```json
{
  "packages": ["git:github.com/jagmarques/asqav-pi"]
}
```

Append `@<commit>` to select a fixed revision. Pi handles project trust and package
loading; inspect its startup diagnostics to confirm that the extension loaded.
The repository's `.pi/settings.json` provides this template.

## Process boundaries

A global package installation does not force all Pi processes to load an extension.
A subprocess can use another configuration directory, disable extensions or override
a package through project settings. Shell profile files also need not be sourced by
an automated process. Configure and check each process that must use the extension.

The gate runs for model tool calls dispatched by that Pi process. It cannot prevent
an extension from invoking code directly, a user from running shell commands, or a
tool from carrying out more than one internal operation. It is not an operating
system isolation boundary. End receipts record the tool name and error flag, not
proof of every side effect.

## Pi documentation

- [Extension events and loading](https://pi.dev/docs/latest/extensions)
- [Package installation and project configuration](https://pi.dev/docs/latest/packages)
- [Settings](https://pi.dev/docs/latest/settings)
