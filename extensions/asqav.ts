/**
 * Asqav extension for the pi coding agent (https://pi.dev): signs and can block
 * each tool call via pi's pre-execution `tool_call` gate; signs `tool:end` after.
 */

import { init, Agent } from "@asqav/sdk";

/** Minimal structural types for pi's extension API (just the `on` overloads),
 * kept loose to avoid depending on @earendil-works/pi-coding-agent. */
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

/** Preflight decision for a tool call; `allowed` is the gate (false + blocking
 * on = the tool never executes). */
export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  reasons?: string[];
}

export interface AsqavPiOptions {
  /** Pre-built Asqav `Agent` (call `init()` + `Agent.create()` first). */
  agent: Agent;
  /** When true (default), a refused preflight blocks the call via `{ block: true }`;
   * false signs for the audit trail but always runs (observe-only). */
  block?: boolean;
  /** Only sign these tool names (e.g. `["bash","write","edit"]`); defaults to
   * all tools, including custom tools other extensions add. */
  tools?: string[];
  /** When true (default), sign a `tool:end` receipt on `tool_result`. */
  signResults?: boolean;
  /** Optional preflight; `allowed: false` blocks without signing a permit.
   * Defaults to a status + policy preflight via `agent.preflight`. */
  preflight?: (actionType: string, input: unknown) => Promise<GuardDecision> | GuardDecision;
  /** Error sink for signing failures (fail-open by default; see `failClosed`). */
  onError?: (err: unknown, ctx: { toolName: string }) => void;
  /** When true, a signing transport error blocks the tool (fail-closed). Default
   * false: an unreachable Asqav must not break a working agent; a real deny still blocks. */
  failClosed?: boolean;
}

function defaultOnError(err: unknown, ctx: { toolName: string }): void {
  // eslint-disable-next-line no-console
  console.warn(`[asqav/pi] sign failed for tool '${ctx.toolName}':`, err);
}

/** Run the configured preflight (defaults to `agent.preflight`, mapped to a
 * GuardDecision). Fail-open: a preflight transport error never blocks. */
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

/** Register Asqav signing on a pi extension API: sign `tool:start` before each
 * tool runs and `tool:end` after; a refused preflight blocks and is signed. */
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

/** Default pi extension entry point (auto-discovered via the `pi.extensions`
 * manifest). Env config: ASQAV_API_KEY, ASQAV_AGENT_NAME, ASQAV_OBSERVE_ONLY,
 * ASQAV_FAIL_CLOSED, ASQAV_FAIL_OPEN; init failure fails closed. See README. */
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
