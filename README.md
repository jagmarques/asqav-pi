# Asqav for Pi

Sign model tool calls in [Pi](https://pi.dev) and block calls refused by Asqav's
preflight or signing response. The extension uses Pi's `tool_call` and `tool_result`
events. It covers tools dispatched through those events in the process that loads it.

## Install

Use Node.js 22.19 or newer. The integration is tested with Pi 0.85.1 and Asqav SDK
0.10.10. Install Pi, then install this repository as a Pi package:

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1
pi install git:github.com/jagmarques/asqav-pi
export ASQAV_API_KEY=your-api-key
export ASQAV_FAIL_CLOSED=true
export ASQAV_MODE=hash-only
pi
```

Pi installs the package's dependencies and loads `extensions/asqav.ts`. To load a
local checkout, run `npm ci` there, then `pi install /absolute/path/to/asqav-pi`.
For a fixed source revision, append `@<commit>` to the Git source.

The [installer guide](docs/asqav-pi-distribution.md) covers shell configuration,
project installs and process boundaries. Installation through Git selects this
repository's code; npm releases have their own versioned contents.

## Decisions and failures

For each selected model tool call, the extension checks agent status and policy,
then requests a `tool:start:<tool-name>` signature. A refused or incomplete
preflight blocks execution in blocking mode. The extension also blocks a signing
response carrying a policy decision other than `permit`.

| Setting | Behavior |
| --- | --- |
| `ASQAV_API_KEY` | Required for the default entry point to initialize an agent. |
| `ASQAV_AGENT_NAME` | Agent name; defaults to `pi`. |
| `ASQAV_FAIL_CLOSED=true` | A signing exception blocks execution. Without this setting, signing exceptions allow the call unless preflight refused it. |
| `ASQAV_OBSERVE_ONLY=true` | Policy refusals allow execution. Signing exceptions still follow `ASQAV_FAIL_CLOSED`. |
| `ASQAV_FAIL_OPEN=true` or `ASQAV_FAIL_CLOSED=false` | Startup failure leaves signing inactive. Otherwise startup failure installs a blocking handler. |

Startup and tool execution have separate failure settings. With no key, observation
mode still blocks on startup unless the startup opt-out is set. Diagnostic failures
do not change these decisions. A signing outage can prevent a denial receipt from
being recorded even when the tool is blocked.

On a completed tool execution, `tool_result` requests a `tool:end:<tool-name>`
signature with the tool name and Pi's error flag. It does not include the tool output
or a tool-call identifier. Result signing cannot undo the tool or replace its result.
The extension does not verify the returned signature or fetch anchors.

## Data sent to Asqav

The start context includes the tool name and validated input. With `ASQAV_MODE=hash-only`,
the SDK hashes that context locally and sends a digest, size and metadata. Tool names,
action types and policy decisions remain visible to the service. With
`ASQAV_MODE=full-payload`, tool inputs are sent in the signing request and can contain
file contents, commands or secrets. End context contains the tool name and error flag.

Without a mode override, the SDK selects hash mode for API hostnames under
`*.asqav.com` and full payload mode for other API hostnames. The default entry point
calls SDK `init()` with automatic mode selection; a valid `ASQAV_MODE` takes precedence.

## Custom configuration

In the Node.js project where Pi will run, install the extension and SDK as local
dependencies. Pi's global package installation does not expose these imports to
custom files in another project.

```bash
npm install "@asqav/pi@git+https://github.com/jagmarques/asqav-pi.git" "@asqav/sdk@^0.10.10"
```

Create `.pi/extensions/asqav-custom.ts` in that project containing:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { init, Agent } from "@asqav/sdk";
import { registerAsqav } from "@asqav/pi/extensions/asqav.ts";

export default async function (pi: ExtensionAPI) {
  init({ apiKey: process.env.ASQAV_API_KEY!, mode: "hash-only" });
  const agent = await Agent.create({ name: "ci-coding-agent" });
  registerAsqav(pi, {
    agent,
    tools: ["bash", "write", "edit"],
    failClosed: true,
  });
}
```

If the default package is already installed in Pi, merge this package override into
the project's `.pi/settings.json` to disable its default extension. Keep existing
settings and package entries. The source must exactly match the installed Pi package;
this example matches the Git source in the install command above.

```json
{
  "packages": [
    { "source": "git:github.com/jagmarques/asqav-pi", "extensions": [] }
  ]
}
```

Run Pi from that project. It discovers the custom extension in `.pi/extensions`.
`registerAsqav` also accepts `block`, `signResults`,
`preflight` and `onError`. A custom preflight returns `{ allowed: boolean, reason?: string }`;
if it throws, Pi blocks the tool. Error callbacks are best effort. Only the default
entry point installs a blocking handler on initialization failure; custom factories
must handle their own startup failures.

The SDK preflight checks status and action-type policy. It does not evaluate the tool
arguments. A custom preflight can inspect the input. A thrown SDK preflight exception
is treated as a cleared preflight by this adapter; the released SDK represents
incomplete network checks as a refusal instead.

## Scope and tests

This extension is not a sandbox. It cannot protect a process that does not load it,
an extension's direct side effects, user shell commands or a tool's internal actions.
A global installation supplies a default package configuration; subprocesses can use
different settings, credentials, environment variables or disabled extensions.

```bash
npm ci
npm run lint
npm run test:coverage
```

Tests include the real Pi loader, agent session and built-in write tool with a local
model response and synthetic HTTP responses. They check dispatch and SDK serialization;
they do not prove live service availability or cryptographic validity.

Licensed under the [Elastic License 2.0](LICENSE).
