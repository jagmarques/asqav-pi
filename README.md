<p align="center">
  <a href="https://asqav.com"><img src="https://asqav.com/logo-text-white.png" alt="Asqav" width="150"></a>
</p>

# @asqav/pi

Stop a rogue agent before it acts, and prove what it tried. This package is an extension for the [pi coding agent](https://pi.dev) that guards pi's tool calls with Asqav. It signs the intended tool call before the tool runs, and blocks the call when Asqav refuses. Every `bash`, `write`, and `edit` your coding agent attempts becomes a tamper-evident receipt, signed server-side with NIST FIPS 204 ML-DSA-65. The agent never holds the signing key, so it cannot forge the record.

This is a pre-execution gate. The extension subscribes to pi's `tool_call` event, which fires before the tool executes and can block, signs `tool:start`, and returns a block when a call is refused so the tool never runs. After execution it signs a matching `tool:end` receipt with the outcome.

## How it hooks in

Pi extensions are TypeScript modules that subscribe to lifecycle events. The `tool_call` event fires after `tool_execution_start` and before the tool executes, and a handler may return `{ block: true, reason }` to stop the tool. The `tool_result` event fires after execution. This extension uses exactly those two events and nothing else, so it stays out of the way of your other extensions.

References, cold-verified:
- [Extensions](https://pi.dev/docs/latest/extensions), covering `tool_call` ("Can block") and `tool_result`
- [Pi packages](https://pi.dev/docs/latest/packages), covering the `pi` manifest and install sources

## Install

Not yet published to npm. Pi installs packages straight from GitHub:

```bash
pi install git:github.com/jagmarques/asqav-pi
```

Once published, the install will be:

```bash
pi install npm:@asqav/pi
```

Pi runs `npm install` for the package, which pulls in the `@asqav/sdk` dependency automatically.

## Setup

Set your Asqav API key and run pi as usual:

```bash
export ASQAV_API_KEY="sk_..."
pi
```

Every tool call pi makes now produces signed `tool:start` and `tool:end` receipts through the Asqav API. Without `ASQAV_API_KEY` the extension logs once and stays inactive, so pi keeps working.

Environment options:

- `ASQAV_AGENT_NAME`: the agent name on receipts. Defaults to `pi`.
- `ASQAV_OBSERVE_ONLY=true`: sign everything, never block.
- `ASQAV_FAIL_CLOSED=true`: block tools when Asqav is unreachable. The default is fail-open so an unreachable Asqav never breaks a working coding agent. A real deny still blocks regardless.

## Programmatic use

When embedding pi via its SDK, or when you want full control over the agent identity and options, register the extension yourself:

```ts
import { init, Agent } from "@asqav/sdk";
import { registerAsqav } from "@asqav/pi/extensions/asqav.js";

init({ apiKey: process.env.ASQAV_API_KEY! });
const agent = await Agent.create({ name: "ci-coding-agent" });

registerAsqav(pi, {
  agent,
  tools: ["bash", "write", "edit"],
  failClosed: true,
});
```

`registerAsqav(pi, options)` accepts:

- `agent`, required: a pre-built Asqav `Agent` from `@asqav/sdk`.
- `block`, defaulting to `true`: when a preflight is refused, block the tool. Set `false` for observe-only signing.
- `tools`: only sign these tool names. Defaults to all tools.
- `signResults`, defaulting to `true`: sign a `tool:end` receipt after each tool runs.
- `preflight`: a custom `(actionType, input) => { allowed, reason }` check. Defaults to `agent.preflight`, which checks revocation, suspension, and active policies.
- `failClosed`, defaulting to `false`: when a signing transport error occurs, block the tool.
- `onError`: sink for signing transport errors. Defaults to `console.warn`.

## How blocking works

When the extension blocks, it returns `{ block: true, reason }` from the `tool_call` handler. Pi surfaces the block to the model as a failed tool call, so the model sees why and can react. The receipt for the refused call records `policy_decision: "deny"`, giving you proof of what the agent tried.

## License

MIT
