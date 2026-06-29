import { describe, it, expect, vi } from "vitest";
import type { Agent } from "@asqav/sdk";
import {
  registerAsqav,
  type PiExtensionAPI,
  type PiToolCallEvent,
  type PiToolResultEvent,
  type ToolCallHandlerResult,
} from "../extensions/asqav.js";

/** Fake pi extension API that captures handlers and lets tests emit tool
 * events. Typed through `unknown` so tests never depend on pi itself. */
function fakePi() {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[event] ??= []).push(handler);
    },
  } as unknown as PiExtensionAPI;
  return {
    pi,
    handlers,
    async emitToolCall(event: PiToolCallEvent): Promise<ToolCallHandlerResult> {
      return (await handlers["tool_call"]?.[0]?.(event, {})) as ToolCallHandlerResult;
    },
    async emitToolResult(event: PiToolResultEvent): Promise<unknown> {
      return handlers["tool_result"]?.[0]?.(event, {});
    },
  };
}

/** Mock Asqav Agent exposing only the surface the extension touches:
 * `sign` and `preflight`. */
function mockAgent(overrides: Partial<{ sign: ReturnType<typeof vi.fn>; preflight: ReturnType<typeof vi.fn> }> = {}) {
  const sign = overrides.sign ?? vi.fn().mockResolvedValue({ signatureId: "sig_1" });
  const preflight =
    overrides.preflight
    ?? vi.fn().mockResolvedValue({ cleared: true, agentActive: true, policyAllowed: true, reasons: [], explanation: "ok" });
  return { agent: { sign, preflight } as unknown as Agent, sign, preflight };
}

describe("registerAsqav tool_call", () => {
  it("signs tool:start with permit and does not block", async () => {
    const { agent, sign } = mockAgent();
    const { pi, emitToolCall } = fakePi();
    registerAsqav(pi, { agent });

    const result = await emitToolCall({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } });

    expect(result).toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({
      actionType: "tool:start:bash",
      toolName: "bash",
      policyDecision: "permit",
    });
  });

  it("blocks and signs a deny when preflight refuses", async () => {
    const preflight = vi
      .fn()
      .mockResolvedValue({ cleared: false, agentActive: false, policyAllowed: false, reasons: ["agent is revoked"], explanation: "agent is revoked" });
    const { agent, sign } = mockAgent({ preflight });
    const { pi, emitToolCall } = fakePi();
    registerAsqav(pi, { agent });

    const result = await emitToolCall({ toolName: "write", toolCallId: "c2", input: { path: "x" } });

    expect(result).toMatchObject({ block: true });
    expect(result && "reason" in result ? result.reason : "").toContain("agent is revoked");
    expect(sign.mock.calls[0][0]).toMatchObject({ policyDecision: "deny", reason: "policy_blocked" });
  });

  it("signs the deny but does not block in observe-only mode", async () => {
    const preflight = vi
      .fn()
      .mockResolvedValue({ cleared: false, agentActive: true, policyAllowed: false, reasons: ["policy"], explanation: "policy" });
    const { agent, sign } = mockAgent({ preflight });
    const { pi, emitToolCall } = fakePi();
    registerAsqav(pi, { agent, block: false });

    const result = await emitToolCall({ toolName: "bash", toolCallId: "c3", input: {} });

    expect(result).toBeUndefined();
    expect(sign.mock.calls[0][0]).toMatchObject({ policyDecision: "deny" });
  });

  it("fails open by default when signing throws", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("network down"));
    const { agent } = mockAgent({ sign });
    const { pi, emitToolCall } = fakePi();
    const onError = vi.fn();
    registerAsqav(pi, { agent, onError });

    const result = await emitToolCall({ toolName: "edit", toolCallId: "c4", input: {} });

    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fails closed when failClosed is set and signing throws", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("network down"));
    const { agent } = mockAgent({ sign });
    const { pi, emitToolCall } = fakePi();
    registerAsqav(pi, { agent, failClosed: true, onError: vi.fn() });

    const result = await emitToolCall({ toolName: "edit", toolCallId: "c5", input: {} });

    expect(result).toMatchObject({ block: true });
  });

  it("skips tools outside the tools filter", async () => {
    const { agent, sign } = mockAgent();
    const { pi, emitToolCall } = fakePi();
    registerAsqav(pi, { agent, tools: ["bash"] });

    const result = await emitToolCall({ toolName: "read", toolCallId: "c6", input: {} });

    expect(result).toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("registerAsqav tool_result", () => {
  it("signs tool:end with the error flag", async () => {
    const { agent, sign } = mockAgent();
    const { pi, emitToolResult } = fakePi();
    registerAsqav(pi, { agent });

    await emitToolResult({ toolName: "bash", toolCallId: "c7", input: {}, isError: true });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({
      actionType: "tool:end:bash",
      policyDecision: "permit",
    });
    expect(sign.mock.calls[0][0].context).toMatchObject({ is_error: true });
  });

  it("does not register a tool_result handler when signResults is false", () => {
    const { agent } = mockAgent();
    const { pi, handlers } = fakePi();
    registerAsqav(pi, { agent, signResults: false });

    expect(handlers["tool_result"]).toBeUndefined();
  });
});
