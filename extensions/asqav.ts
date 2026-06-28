/**
 * Asqav extension for the pi coding agent (https://pi.dev).
 *
 * Subscribes to pi's `tool_call` event, which fires before a tool executes
 * and can block, so Asqav signs the intended tool call before it runs and
 * blocks a refused call. This is a pre-execution gate: stop a rogue agent
 * before it acts, and prove what it tried. The `tool_result` event signs a
 * matching `tool:end` receipt after execution.
 *
 * The pi extension API (cold-verified against the current docs):
 *   pi.on("tool_call", async (event, ctx) => { ... })
 * where the handler may return `{ block: true, reason?: string }` to stop
 * the tool, and
 *   pi.on("tool_result", async (event, ctx) => { ... })
 * which fires after execution and may patch the result (this extension
 * never does; it only signs).
 *
 * Source URLs verified:
 *   - https://pi.dev/docs/latest/extensions
 *     ("tool_call ... Fired after tool_execution_start, before the tool
 *      executes. Can block."; "Return values from tool_call only control
 *      blocking via { block: true, reason?: string }")
 *   - https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
 *   - https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
 *     (package `pi` manifest, `extensions/` convention directory)
 */

import { init, Agent } from "@asqav/sdk";

/**
 * Minimal structural types for the pi extension API. We only need `on` with
 * the two tool events, so we type just that surface and avoid a dependency
 * on `@earendil-works/pi-coding-agent`. Kept loose on purpose so this
 * extension stays compatible as pi evolves.
 */
export interface PiToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface PiToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  isError?: boolean;
}

export type ToolCallHandlerResult = { block: true; reason?: string } | undefined | void;

export interface PiExtensionAPI {
  on(
    event: "tool_call",
    handler: (event: PiToolCallEvent, ctx: unknown) => Promise<ToolCallHandlerResult> | ToolCallHandlerResult,
  ): void;
  on(
    event: "tool_result",
    handler: (event: PiToolResultEvent, ctx: unknown) => Promise<unknown> | unknown,
  ): void;
  // pi exposes more events and members; this extension does not use them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: any) => any): void;
}

/**
 * The decision an Asqav preflight yields for a tool call. `allowed` is the
 * gate: when false and blocking is on, the tool never executes.
 */
export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  reasons?: string[];
}

export interface AsqavPiOptions {
  /**
   * Pre-built Asqav `Agent`. Call `init()` and `Agent.create()` from
   * `@asqav/sdk` first, then pass the agent here.
   */
  agent: Agent;
  /**
   * When true (default), a refused preflight blocks the tool call via
   * `{ block: true }` (pre-execution gate). When false, the call is signed
   * for the audit trail but always allowed to run (observe-only).
   */
  block?: boolean;
  /**
   * Only sign these tool names (for example `["bash", "write", "edit"]`).
   * Defaults to all tools, including custom tools other extensions add.
   */
  tools?: string[];
  /**
   * When true (default), sign a `tool:end` receipt on `tool_result` so the
   * record shows the outcome, including whether the tool errored.
   */
  signResults?: boolean;
  /**
   * Optional preflight before signing. When supplied and it returns
   * `allowed: false`, the tool is blocked without ever signing a permit.
   * Defaults to a status + policy preflight via `agent.preflight`.
   */
  preflight?: (actionType: string, input: unknown) => Promise<GuardDecision> | GuardDecision;
  /**
   * Error sink for signing failures. Signing is fail-open by default: a
   * network error does not block the tool. Set `failClosed: true` to block
   * instead.
   */
  onError?: (err: unknown, ctx: { toolName: string }) => void;
  /**
   * When true, a signing transport error blocks the tool (fail-closed).
   * Defaults to false (fail-open): governance must not break a working
   * coding agent when Asqav is unreachable. A refused preflight (a real
   * deny) still blocks regardless of this flag.
   */
  failClosed?: boolean;
}

function defaultOnError(err: unknown, ctx: { toolName: string }): void {
  // eslint-disable-next-line no-console
  console.warn(`[asqav/pi] sign failed for tool '${ctx.toolName}':`, err);
}

/**
 * Run the configured preflight. Defaults to `agent.preflight`, mapping its
 * `PreflightResult` onto a `GuardDecision`. Fail-open: a preflight transport
 * error never blocks on its own.
 */
async function runPreflight(
  opts: AsqavPiOptions,
  actionType: string,
  input: unknown,
): Promise<GuardDecision> {
  if (opts.preflight) {
    return opts.preflight(actionType, input);
  }
  try {
    const result = await opts.agent.preflight(actionType);
    return {
      allowed: result.cleared,
      reason: result.cleared ? undefined : result.explanation,
      reasons: result.reasons,
    };
  } catch {
    // Preflight is best-effort; a transport error never blocks on its own.
    return { allowed: true };
  }
}

/**
 * Register Asqav signing on a pi extension API. Every tool call pi makes
 * produces a signed `tool:start` receipt before the tool runs, and a
 * `tool:end` receipt after. A refused preflight blocks the tool and the
 * deny is signed, so the record shows what the agent tried.
 *
 * Use this directly when embedding pi via its SDK, or rely on the default
 * export, which reads `ASQAV_API_KEY` and registers automatically.
 */
export function registerAsqav(pi: PiExtensionAPI, options: AsqavPiOptions): void {
  const block = options.block !== false;
  const signResults = options.signResults !== false;
  const onError = options.onError ?? defaultOnError;

  pi.on("tool_call", async (event): Promise<ToolCallHandlerResult> => {
    if (options.tools && !options.tools.includes(event.toolName)) {
      return;
    }
    const actionType = `tool:start:${event.toolName}`;

    // 1. Preflight: a hard deny here blocks before any permit signs.
    const pre = await runPreflight(options, actionType, event.input);

    // 2. Sign the intended tool call. The receipt records what the agent
    //    tried, before it runs. A deny is signed as a deny.
    try {
      await options.agent.sign({
        actionType,
        toolName: event.toolName,
        context: { tool_name: event.toolName, input: event.input },
        policyDecision: pre.allowed ? "permit" : "deny",
        ...(pre.allowed ? {} : { reason: "policy_blocked" as const }),
      });
    } catch (err) {
      onError(err, { toolName: event.toolName });
      if (options.failClosed) {
        return { block: true, reason: "Asqav signing unavailable (fail-closed)" };
      }
      // Fail-open: continue to the real tool.
    }

    // 3. Block the tool only on a real deny.
    if (!pre.allowed && block) {
      const reason =
        pre.reason ?? (pre.reasons && pre.reasons.join("; ")) ?? "Asqav preflight refused";
      return { block: true, reason: `Asqav blocked tool '${event.toolName}': ${reason}` };
    }
  });

  if (signResults) {
    pi.on("tool_result", async (event: PiToolResultEvent) => {
      if (options.tools && !options.tools.includes(event.toolName)) {
        return;
      }
      try {
        await options.agent.sign({
          actionType: `tool:end:${event.toolName}`,
          toolName: event.toolName,
          context: { tool_name: event.toolName, is_error: event.isError === true },
          policyDecision: "permit",
        });
      } catch (err) {
        onError(err, { toolName: event.toolName });
      }
      // Never patch the result; this extension only signs.
    });
  }
}

/** Reason returned for every tool call when governance was intended but init failed. */
export const INIT_FAIL_CLOSED_REASON =
  "asqav governance could not initialize (e.g. missing ASQAV_API_KEY or signer unreachable); failing closed - no tool runs ungoverned";

// True when an init failure should block every tool rather than run pi
// ungoverned. Default on; opt out with ASQAV_FAIL_OPEN/ASQAV_FAIL_CLOSED.
export function initFailClosedInEffect(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ASQAV_FAIL_OPEN === "true") return false;
  if (env.ASQAV_FAIL_CLOSED === "false") return false;
  return true;
}

/** Register a tool_call handler that blocks every tool when init failed. */
export function registerInitFailClosed(pi: PiExtensionAPI): void {
  pi.on("tool_call", (): ToolCallHandlerResult => {
    return { block: true, reason: INIT_FAIL_CLOSED_REASON };
  });
}

/**
 * Default pi extension entry point. Pi auto-discovers this file via the
 * package's `pi.extensions` manifest and calls it with the extension API.
 *
 * Configuration comes from the environment:
 * - `ASQAV_API_KEY` (required): your Asqav API key. Without it, init fails;
 *   by default that fails closed and blocks every tool call.
 * - `ASQAV_AGENT_NAME` (optional): the agent name on receipts. Defaults
 *   to "pi".
 * - `ASQAV_OBSERVE_ONLY=true` (optional): sign everything, never block.
 * - `ASQAV_FAIL_CLOSED=true` (optional): block tools when signing is
 *   unreachable. Init failure already fails closed by default.
 * - `ASQAV_FAIL_OPEN=true` (or `ASQAV_FAIL_CLOSED=false`): deliberate dev
 *   opt-out that restores the old inactive/allow behavior on init failure.
 */
export default async function asqavExtension(pi: PiExtensionAPI): Promise<void> {
  const failClosed = initFailClosedInEffect();
  const apiKey = process.env.ASQAV_API_KEY;
  if (!apiKey) {
    if (failClosed) {
      // eslint-disable-next-line no-console
      console.error(
        "[asqav/pi] ASQAV_API_KEY not set; failing closed and blocking all tool calls. Set ASQAV_FAIL_OPEN=true to run ungoverned.",
      );
      registerInitFailClosed(pi);
    } else {
      // eslint-disable-next-line no-console
      console.warn("[asqav/pi] ASQAV_API_KEY not set and fail-open opt-out is set; Asqav signing is inactive.");
    }
    return;
  }
  try {
    init({ apiKey });
    const agent = await Agent.create({ name: process.env.ASQAV_AGENT_NAME ?? "pi" });
    registerAsqav(pi, {
      agent,
      block: process.env.ASQAV_OBSERVE_ONLY !== "true",
      failClosed: process.env.ASQAV_FAIL_CLOSED === "true",
    });
  } catch (err) {
    if (failClosed) {
      // Init failed but governance was intended: block everything.
      // eslint-disable-next-line no-console
      console.error(
        "[asqav/pi] failed to initialize Asqav agent; failing closed and blocking all tool calls. Set ASQAV_FAIL_OPEN=true to run ungoverned:",
        err,
      );
      registerInitFailClosed(pi);
    } else {
      // eslint-disable-next-line no-console
      console.warn("[asqav/pi] failed to initialize Asqav agent and fail-open opt-out is set; signing is inactive:", err);
    }
  }
}
