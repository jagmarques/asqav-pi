import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { init, Agent } from "@asqav/sdk";
import extension, { registerAsqav, type AsqavPiOptions } from "../extensions/asqav.js";

const agentData = { agent_id: "test-agent", name: "pi", public_key: "fixture", key_id: "test-key", algorithm: "ml-dsa-65", created_at: "2026-09-06T00:00:00Z" };
const receipt = { signature: "fixture", signature_id: "sig", action_id: "act", timestamp: agentData.created_at, verification_url: "https://example.invalid/receipt", policy_decision: "permit" };
let root: string;
let requests: Array<{ path: string; body: Record<string, unknown> | null }>;
let status: unknown;
let policies: unknown;
let signResponse: unknown;
let signStatus: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "asqav-pi-test-"));
  requests = []; status = { revoked: false, suspended: false }; policies = []; signResponse = receipt; signStatus = 200;
  for (const key of ["ASQAV_FAIL_CLOSED", "ASQAV_FAIL_OPEN", "ASQAV_OBSERVE_ONLY"]) vi.stubEnv(key, "");
  vi.stubEnv("ASQAV_API_KEY", "synthetic-pi-test-key"); vi.stubEnv("ASQAV_MODE", "hash-only");
  vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: opts.body ? JSON.parse(String(opts.body)) : null });
    if (path.endsWith("/agents/create")) return Response.json(agentData);
    if (path.endsWith("/status")) return Response.json(status);
    if (path.endsWith("/policies")) return Response.json(policies);
    if (path.endsWith("/sign")) return Response.json(signResponse, { status: signStatus });
    throw Error(`Unexpected HTTP ${path}`);
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

async function run(factory: ExtensionFactory = extension, fromFile = false) {
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    ...(fromFile ? { additionalExtensionPaths: [resolve("extensions/asqav.ts")] } : { extensionFactories: [factory] }) });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = modelRuntime.getModels()[0]!;
  const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir, settingsManager, sessionManager: SessionManager.inMemory(root), resourceLoader: loader, modelRuntime, model, tools: ["write"] });
  let turns = 0;
  session.agent.streamFunction = () => {
    const content: AssistantMessage["content"] = turns++ === 0
      ? [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "effect.txt", content: "private tool input" } }]
      : [{ type: "text", text: "done" }];
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: content[0]!.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); return stream;
  };
  try { await session.agent.prompt("Write a local test file"); }
  finally { session.dispose(); }
  const effect = await readFile(join(root, "effect.txt"), "utf8").catch(() => null);
  return { effect, loaded: extensionsResult.extensions.length, errors: extensionsResult.errors, messages: session.agent.state.messages.filter(m => m.role === "toolResult") };
}
function configured(options: Partial<AsqavPiOptions>): ExtensionFactory {
  return async pi => { init({ apiKey: "synthetic-pi-test-key" }); const agent = await Agent.create({ name: "test" }); registerAsqav(pi, { agent, ...options }); };
}
const signs = () => requests.filter(r => r.path.endsWith("/sign"));

describe("real Pi loader, session and built-in write execution", () => {
  it("loads the package source and signs both events with the released SDK", async () => {
    const result = await run(extension, true);
    expect(result.errors).toEqual([]); expect(result.loaded).toBe(1); expect(result.effect).toBe("private tool input");
    expect(signs().map(r => r.body?.action_type)).toEqual(["tool:start:write", "tool:end:write"]);
    expect(signs().every(r => String(r.body?.hash).startsWith("sha256:"))).toBe(true);
    expect(JSON.stringify(signs())).not.toContain("private tool input");
  });
  it.each(["missing-key", "create-failure"])("blocks %s even when diagnostics throw", async scenario => {
    if (scenario === "missing-key") vi.stubEnv("ASQAV_API_KEY", "");
    else vi.stubGlobal("fetch", async () => Response.json({ detail: "unavailable" }, { status: 400 }));
    vi.spyOn(console, "error").mockImplementation(() => { throw Error("diagnostic failed"); });
    const result = await run(); expect(result.errors).toEqual([]); expect(result.loaded).toBe(1); expect(result.effect).toBeNull();
  });
  it.each(["ASQAV_FAIL_OPEN", "ASQAV_FAIL_CLOSED"])("honors the explicit %s startup opt-out", async flag => {
    vi.stubEnv("ASQAV_API_KEY", ""); vi.stubEnv(flag, flag === "ASQAV_FAIL_OPEN" ? "true" : "false");
    vi.spyOn(console, "warn").mockImplementation(() => { throw Error("diagnostic failed"); });
    expect((await run()).effect).toBe("private tool input"); expect(signs()).toHaveLength(0);
  });
  it.each(["revoked", "policy", "incomplete"])("blocks a %s preflight and attempts a denial receipt", async reason => {
    if (reason === "revoked") status = { revoked: true };
    if (reason === "policy") policies = [{ is_active: true, action_pattern: "tool:start:*", action: "block", name: "test" }];
    if (reason === "incomplete") status = null;
    expect((await run()).effect).toBeNull(); expect(signs()[0]?.body?.policy_decision).toBe("deny");
  });
  it("blocks a signer refusal after a cleared preflight", async () => {
    signResponse = { ...receipt, policy_decision: "deny" };
    expect((await run()).effect).toBeNull();
  });
  it.each([false, true])("signing errors honor failClosed=%s despite a throwing error sink", async failClosed => {
    signStatus = 400; signResponse = { detail: "unavailable" };
    expect((await run(configured({ failClosed, onError: () => { throw Error("sink failed"); } }))).effect).toBe(failClosed ? null : "private tool input");
  });
  it("uses the default error sink and stays fail-open when signing fails end to end", async () => {
    signStatus = 400; signResponse = { detail: "unavailable" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await run();
    expect(result.errors).toEqual([]); expect(result.effect).toBe("private tool input");
    expect(warn.mock.calls.some(args => String(args[0]).includes("[asqav/pi]"))).toBe(true);
  });
  it("observe mode allows a refused preflight", async () => {
    status = { revoked: true }; vi.stubEnv("ASQAV_OBSERVE_ONLY", "true");
    expect((await run()).effect).toBe("private tool input"); expect(signs()[0]?.body?.policy_decision).toBe("deny");
  });
  it("custom preflight throws block execution through the host", async () => {
    expect((await run(configured({ preflight: () => { throw Error("cannot evaluate"); } }))).effect).toBeNull(); expect(signs()).toHaveLength(0);
  });
  it("preserves the actual tool result when end signing fails", async () => {
    let ends = 0;
    vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/agents/create")) return Response.json(agentData);
      if (path.endsWith("/status")) return Response.json({});
      if (path.endsWith("/policies")) return Response.json([]);
      if (path.endsWith("/sign")) { const body = JSON.parse(String(opts.body)); if (body.action_type.startsWith("tool:end:")) { ends++; return Response.json({}, { status: 400 }); } return Response.json(receipt); }
      throw Error(path);
    });
    const result = await run(configured({ onError: () => { throw Error("sink failed"); } }));
    expect(result.effect).toBe("private tool input"); expect(ends).toBe(1); expect(result.messages[0]).toMatchObject({ isError: false });
  });
});
