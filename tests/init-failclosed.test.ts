import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PiExtensionAPI, PiToolCallEvent, ToolCallHandlerResult } from "../extensions/asqav.js";

// Mock the Asqav SDK to drive the default extension's init path:
// a clean init success, and an Agent.create that throws.
const init = vi.fn();
const create = vi.fn();
vi.mock("@asqav/sdk", () => ({
  init: (...args: unknown[]) => init(...args),
  Agent: { create: (...args: unknown[]) => create(...args) },
}));

import asqavExtension from "../extensions/asqav.js";

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
  };
}

const SAVED = { ...process.env };

beforeEach(() => {
  init.mockReset();
  create.mockReset();
  delete process.env.ASQAV_API_KEY;
  delete process.env.ASQAV_FAIL_OPEN;
  delete process.env.ASQAV_FAIL_CLOSED;
  delete process.env.ASQAV_OBSERVE_ONLY;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...SAVED };
});

describe("default extension init fail-closed", () => {
  it("blocks every tool call when ASQAV_API_KEY is missing (default fail-closed)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pi, emitToolCall } = fakePi();

    await asqavExtension(pi);

    const result = await emitToolCall({ toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /" } });
    expect(result).toMatchObject({ block: true });
    expect(result && "reason" in result ? result.reason : "").toContain("failing closed");
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks every tool call when Agent.create throws (default fail-closed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ASQAV_API_KEY = "sk_test_x";
    create.mockRejectedValue(new Error("signer unreachable"));
    const { pi, emitToolCall } = fakePi();

    await asqavExtension(pi);

    const result = await emitToolCall({ toolName: "write", toolCallId: "c2", input: { path: "x" } });
    expect(result).toMatchObject({ block: true });
    expect(result && "reason" in result ? result.reason : "").toContain("could not initialize");
  });

  it("does NOT block on init failure when ASQAV_FAIL_OPEN=true (opt-out), and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ASQAV_FAIL_OPEN = "true";
    const { pi, emitToolCall, handlers } = fakePi();

    await asqavExtension(pi);

    expect(handlers["tool_call"]).toBeUndefined();
    const result = await emitToolCall({ toolName: "bash", toolCallId: "c3", input: {} });
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("fail-open opt-out");
  });

  it("honors ASQAV_FAIL_CLOSED=false as the documented opt-out on init failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ASQAV_API_KEY = "sk_test_x";
    process.env.ASQAV_FAIL_CLOSED = "false";
    create.mockRejectedValue(new Error("signer unreachable"));
    const { pi, emitToolCall, handlers } = fakePi();

    await asqavExtension(pi);

    expect(handlers["tool_call"]).toBeUndefined();
    const result = await emitToolCall({ toolName: "edit", toolCallId: "c4", input: {} });
    expect(result).toBeUndefined();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("fail-open opt-out");
  });

  it("init SUCCESS path registers normal signing and allows a permitted call", async () => {
    process.env.ASQAV_API_KEY = "sk_test_x";
    const sign = vi.fn().mockResolvedValue({ signatureId: "sig_1" });
    const preflight = vi
      .fn()
      .mockResolvedValue({ cleared: true, agentActive: true, policyAllowed: true, reasons: [], explanation: "ok" });
    create.mockResolvedValue({ sign, preflight });
    const { pi, emitToolCall } = fakePi();

    await asqavExtension(pi);

    expect(init).toHaveBeenCalledTimes(1);
    const result = await emitToolCall({ toolName: "bash", toolCallId: "c5", input: { command: "ls" } });
    expect(result).toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({ actionType: "tool:start:bash", policyDecision: "permit" });
  });
});
