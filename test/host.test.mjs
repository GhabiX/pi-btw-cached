import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { getOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";

// Test files go under the repo's ignored temp/.
mkdirSync(resolve("temp"), { recursive: true });
const temporaryRoot = mkdtempSync(join(resolve("temp"), "host-test-"));
// Wire shape of each API as the local server receives it (Google's SDK turns
// params.config into top-level REST fields).
const historyKey = api => ({ "openai-completions": "messages", "anthropic-messages": "messages",
  "google-generative-ai": "contents" })[api] ?? "input";
// Pi encodes the side question; the server recognises it by the note btw appends.
const isSide = body => JSON.stringify(body).includes("(Side question: answer from the conversation so far.");
// Pi moves Anthropic cache breakpoints to the newest message on every request,
// writing that message as text blocks and earlier ones as plain strings. A
// breakpoint marks the prefix and is not prompt content, and a string is the
// shorthand for one text block, so both forms render the same prompt.
const canonical = (api, value) => JSON.parse(JSON.stringify(value, (key, v) => key === "cache_control" ? undefined
  : api === "anthropic-messages" && key === "content" && typeof v === "string" ? [{ type: "text", text: v }] : v));
// A payload hook loaded after btw; side requests run the same hook chain.
const lateHook = (api, payload) => api === "google-generative-ai"
  ? { ...payload, config: { ...payload.config, temperature: 0.123 } } : { ...payload, user: "late-payload-replacement" };
const lateMark = (api, body) => api === "google-generative-ai" ? body.generationConfig?.temperature === 0.123
  : body.user === "late-payload-replacement";
const authHeader = (api, headers) => api === "anthropic-messages" ? headers["x-api-key"]
  : api === "google-generative-ai" ? headers["x-goog-api-key"] : headers.authorization?.replace(/^Bearer /, "");

// Every provider HTTP call below goes to this local scripted server. No model
// endpoint, credential file, or real SpineTree is used.
function scriptedServer(api, holdMain = false, websocket = false, toolCallMode, truncateAt = 0) {
  const holdAt = holdMain === true ? 1 : holdMain || 0;
  const requests = [];
  const headers = [];
  const transports = [];
  let releaseMain;
  let readyMain;
  const mainReady = new Promise(done => { readyMain = done; });
  const respond = async (payload, requestHeaders, emit, transport) => {
    requests.push(payload);
    headers.push(requestHeaders);
    transports.push(transport);
    const side = isSide(payload);
    const text = side ? "SIDE answer" : "MAIN answer";
    const hold = async () => {
      if (!side && requests.length === holdAt) {
        readyMain();
        await new Promise(done => { releaseMain = done; });
      }
    };
    if (api === "anthropic-messages") {
      emit({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: payload.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
      emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      await hold();
      emit({ type: "content_block_stop", index: 0 });
      if (side) {
        emit({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "btw_probe", input: {} } });
        emit({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });
        emit({ type: "content_block_stop", index: 1 });
      }
      emit({ type: "message_delta", delta: { stop_reason: side ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      emit({ type: "message_stop" });
    } else if (api === "google-generative-ai") {
      const chunk = (parts, finishReason) => ({ candidates: [{ index: 0, content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }],
        ...(finishReason ? { usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } } : {}) });
      emit(chunk([{ text }]));
      await hold();
      emit(chunk(side ? [{ functionCall: { name: "btw_probe", args: {} } }] : [], "STOP"));
    } else if (api !== "openai-completions") {
      const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      emit({ type: "response.created", response: { id: "resp_1" } });
      emit({ type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } });
      emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
      if (!side && requests.length === holdAt) {
        readyMain();
        await new Promise(done => { releaseMain = done; });
      }
      emit({ type: "response.output_item.done", output_index: 0, item: message });
      const output = [message];
      if (side || (toolCallMode && requests.length === 1)) {
        const codemode = toolCallMode === "codemode";
        const call = codemode
          ? { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "codemode",
              input: "text(await tools.btw_probe({}));", status: "completed" }
          : { type: "function_call", id: "fc_1", call_id: "call_1", name: "btw_probe", arguments: "{}", status: "completed" };
        emit({ type: "response.output_item.added", output_index: 1,
          item: { ...call, ...(codemode ? { input: "" } : { arguments: "" }) } });
        emit(codemode
          ? { type: "response.custom_tool_call_input.done", output_index: 1, input: call.input }
          : { type: "response.function_call_arguments.done", output_index: 1, arguments: "{}" });
        emit({ type: "response.output_item.done", output_index: 1, item: call });
        output.push(call);
      }
      // truncateAt: that main request stops below its output limit, which Pi recovers by compacting and continuing.
      const truncated = !side && requests.length === truncateAt;
      emit({ type: truncated ? "response.incomplete" : "response.completed", response: { id: "resp_1",
        status: truncated ? "incomplete" : "completed", ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
    } else {
      const chunk = (delta, finish_reason = null) => ({ id: "chat_1", object: "chat.completion.chunk", created: 1,
        model: payload.model, choices: [{ index: 0, delta, finish_reason }] });
      emit(chunk({ role: "assistant", content: text }));
      if (!side && requests.length === holdAt) {
        readyMain();
        await new Promise(done => { releaseMain = done; });
      }
      if (side) emit(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "btw_probe", arguments: "{}" } }] }));
      emit(chunk({}, side ? "tool_calls" : "stop"));
    }
  };
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts);
    const body = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = data => api === "anthropic-messages" ? `event: ${data.type}\n` : "";
    await respond(JSON.parse(body), req.headers, data => res.write(`${event(data)}data: ${JSON.stringify(data)}\n\n`), "sse");
    if (api === "openai-completions") res.write("data: [DONE]\n\n");
    res.end();
  });
  const wss = websocket ? new WebSocketServer({ server }) : undefined;
  wss?.on("connection", (socket, req) => {
    socket.on("message", async bytes => {
      const { type, ...payload } = JSON.parse(bytes.toString());
      assert.equal(type, "response.create");
      await respond(payload, req.headers, data => socket.send(JSON.stringify(data)), "websocket");
    });
  });
  return { server, wss, requests, headers, transports, mainReady, release: () => releaseMain?.() };
}

function offlineOAuth(account = "btw-test-account") {
  // Constructed test data; never load a user's token or invoke login/refresh.
  const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url");
  return { type: "oauth", access: `e30.${claim}.offline`, refresh: "offline-not-a-refresh-token", expires: Date.now() + 3_600_000 };
}

async function harness(api, { plugin = true, holdMain = false, provider = "custom", transport = "sse",
  toolCallMode, codemodeMode, warm = false, truncateAt = 0 } = {}) {
  // warm: Pi's own cache warmer refreshes 1 s after each main request (11 s
  // lifetime, priced so the refresh is always worth it).
  const warming = warm ? { promptCache: { short: 11 }, cost: { input: 1000, output: 1000, cacheRead: 1, cacheWrite: 10_000 } } : {};
  const cwd = mkdtempSync(join(temporaryRoot, "host-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const wire = scriptedServer(api, holdMain, transport !== "sse", toolCallMode, truncateAt);
  await new Promise(done => wire.server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${wire.server.address().port}/v1`;
  const settingsManager = SettingsManager.inMemory({ cacheWarming: warm ? "streaming" : "off", transport,
    compaction: truncateAt ? { enabled: true, keepRecentTokens: 1 } : { enabled: false },
    ...(codemodeMode ? { defaultTools: ["+codemode"], codemode: { mode: codemodeMode } } : {}) });
  const credentials = new InMemoryCredentialStore();
  const codex = api === "openai-codex-responses";
  let nativeProvider;
  if (codex) {
    const original = openaiCodexProvider();
    const catalogModel = original.getModels().find(model => model.id === "gpt-6.1-sol");
    assert.ok(catalogModel, "the real provider catalog must contain the requested model");
    const models = [{ ...catalogModel, baseUrl, reasoning: false, maxTokens: 1000, headers: {
      "x-model-probe": "model-config-kept", "x-provider-probe": "provider-config-kept",
    } }];
    nativeProvider = { ...original, baseUrl, getModels: () => models, getAllModels: () => models };
    await credentials.modify(provider, async () => offlineOAuth());
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStorePath: join(agentDir, "catalog"), refreshOnCreate: false });
  const notices = [], widgets = [], errors = [], toolEvents = [];
  let executions = 0, payloadHooks = 0;
  const factories = [pi => {
    if (nativeProvider) pi.registerProvider(nativeProvider);
    else pi.registerProvider(provider, { api, baseUrl, apiKey: "offline-scripted-test", models: [{ id: "gpt-6.1-sol",
      name: "scripted sol", input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { "x-model-probe": "model-config-kept" }, ...warming,
      ...(codemodeMode ? { compat: { supportsOpenAIGrammarTools: true } } : {}) }],
      headers: { "x-provider-probe": "provider-config-kept" } });
    pi.registerTool({ name: "btw_probe", label: "probe", description: "Count tool executions", parameters: { type: "object", properties: {} },
      async execute() { executions++; return { content: [{ type: "text", text: "executed" }], details: {} }; } });
  }];
  if (codemodeMode) factories.push(createCodemodeExtension());
  // These run after btw in load order, including a replacing payload hook.
  factories.push(pi => {
    pi.on("tool_call", event => { toolEvents.push(event); });
    pi.on("tool_result", event => { toolEvents.push(event); });
    pi.on("before_agent_start", () => ({ systemPrompt: "FINAL SYSTEM 🦴" }));
    pi.on("context", event => ({ messages: [...event.messages, { role: "user", content: "LATE CONTEXT 🌲", timestamp: 1 }] }));
    pi.on("context_with_system", event => ({ messages: [...event.messages.map(message => message.role === "system"
      ? { ...message, content: "INTERMEDIATE SYSTEM 🦴" } : message),
      { role: "user", content: "FULL CONTEXT AFTER SYSTEM", timestamp: 1 }] }));
    pi.on("before_provider_request", event => { payloadHooks++; return lateHook(api, event.payload); });
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: factories,
    additionalExtensionPaths: plugin ? [resolve("extensions/btw.ts")] : [],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: ["mcp", "llama", "codemode"], systemPrompt: "BASE SYSTEM" });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = nativeProvider?.getModels()[0] ?? { id: "gpt-6.1-sol", name: "scripted sol", provider, api, baseUrl, reasoning: false,
    input: ["text"], contextWindow: 200_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...warming,
    ...(codemodeMode ? { compat: { supportsOpenAIGrammarTools: true } } : {}) };
  const manager = SessionManager.inMemory(cwd, { id: "btw-test-session" });
  const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, thinkingLevel: "off",
    settingsManager, sessionManager: manager, resourceLoader: loader, ...(codemodeMode ? {} : { tools: ["btw_probe"] }) });
  await session.bindExtensions({ mode: "tui", uiContext: {
    notify: (message, type) => notices.push({ message, type }),
    setWidget: (_key, content) => widgets.push(content),
  }, onError: error => errors.push(error) });
  return { ...wire, session, manager, notices, widgets, errors, toolEvents, executions: () => executions, payloadHooks: () => payloadHooks,
    nativeIntact: () => {
      if (!nativeProvider) return;
      const registered = runtime.getRegisteredNativeProvider(provider);
      assert.equal(registered.auth, nativeProvider.auth);
      assert.equal(registered.getModels, nativeProvider.getModels);
      assert.equal(registered.stream, nativeProvider.stream);
      assert.equal(registered.baseUrl, nativeProvider.baseUrl);
      assert.equal(registered.headers, nativeProvider.headers);
      assert.equal(runtime.getRegisteredProviderConfig(provider), undefined);
    },
    rotateAccount: async account => credentials.modify(provider, async () => offlineOAuth(account)),
    close: async () => {
      wire.release(); session.dispose();
      for (const socket of wire.wss?.clients ?? []) socket.close();
      await Promise.all([new Promise(done => wire.server.close(done)),
        wire.wss ? new Promise(done => wire.wss.close(done)) : Promise.resolve()]);
    } };
}

/** Tool declarations: top-level `tools`, or (Pi >= 1.4, Codex models with
 * additional-tools support) an `additional_tools` input item. */
function declaredTools(body) {
  return body.tools ?? body.input?.find(item => item.type === "additional_tools")?.tools ?? [];
}

function assertReplay(main, side, api, question) {
  const key = historyKey(api);
  assert.ok(isSide(side));
  assert.ok(!isSide(main));
  assert.ok(declaredTools(main).length > 0);
  const keyText = JSON.stringify(main[key]);
  assert.ok(keyText.includes("LATE CONTEXT 🌲"));
  assert.ok(keyText.includes("FULL CONTEXT AFTER SYSTEM"));
  // Pi's forced-prompt projection runs after context_with_system (AgentSession
  // _installAgentForcedPromptProjection), so the real request has FINAL SYSTEM.
  const whole = JSON.stringify(main);
  assert.ok(whole.includes("FINAL SYSTEM 🦴"), whole);
  assert.ok(!whole.includes("INTERMEDIATE SYSTEM 🦴"));
  assert.ok(lateMark(api, main));
  assert.ok(lateMark(api, side));
  // The side request is the main request plus one history item holding the
  // question; tools, tool choice and every other field are unchanged.
  const [m, s] = [canonical(api, main), canonical(api, side)];
  assert.equal(s[key].length, m[key].length + 1, JSON.stringify(s[key]));
  assert.ok(JSON.stringify(s[key].at(-1)).includes(question));
  assert.deepEqual({ ...s, [key]: s[key].slice(0, -1) }, m);
}

for (const mode of ["on", "only"]) {
  test(`codemode ${mode}: nested tools preserve /btw replay, no history and no side tool execution`, async () => {
    const api = "openai-responses";
    const direct = await harness(api, { toolCallMode: "direct" });
    const actual = await harness(api, { toolCallMode: "codemode", codemodeMode: mode });
    const control = await harness(api, { toolCallMode: "codemode", codemodeMode: mode, plugin: false });
    try {
      await direct.session.prompt("MAIN first");
      await actual.session.prompt("MAIN first");
      assert.equal(actual.executions(), direct.executions(), JSON.stringify(actual.session.messages));
      assert.equal(actual.executions(), 1);
      assert.ok(actual.session.getActiveToolNames().includes("codemode"));
      assert.ok(declaredTools(actual.requests[0]).some(tool => tool.name === "codemode"));
      assert.equal(declaredTools(actual.requests[0]).some(tool => tool.name === "btw_probe"), mode === "on");
      // /btw is a user command, not a registered model tool: no exposure to set.
      assert.ok(!declaredTools(actual.requests[0]).some(tool => tool.name === "btw"));
      const results = h => h.toolEvents.filter(event => event.type === "tool_result" && event.toolName === "btw_probe");
      assert.deepEqual(results(actual)[0].content, results(direct)[0].content);
      assert.deepEqual(results(actual)[0].input, results(direct)[0].input);
      const nestedCall = actual.toolEvents.find(event => event.type === "tool_call" && event.toolName === "btw_probe");
      assert.ok(nestedCall.parentToolCallId);
      assert.equal(direct.toolEvents.find(event => event.type === "tool_call" && event.toolName === "btw_probe").parentToolCallId, undefined);
      const outerResult = actual.session.messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
      assert.equal(outerResult.isError, false);
      assert.match(outerResult.content.map(part => part.text ?? "").join("\n"), /executed/);
      assert.equal(outerResult.nestedCalls.calls[0].name, "btw_probe");
      assert.equal(actual.session.messages.some(message => message.role === "toolResult" && message.toolName === "btw_probe"), false);
      for (const h of [direct, actual]) {
        const entries = JSON.stringify(h.manager.getEntries());
        const messages = JSON.stringify(h.session.messages);
        await h.session.prompt("/btw SIDE after tools");
        // The latest snapshot is the follow-up request, including the real tool
        // result (outer codemode only). The side provider even emits a tool call.
        assertReplay(h.requests[1], h.requests[2], api, "SIDE after tools");
        assert.equal(JSON.stringify(h.manager.getEntries()), entries);
        assert.equal(JSON.stringify(h.session.messages), messages);
        assert.equal(h.executions(), 1);
        assert.deepEqual(h.widgets.at(-1), ["/btw SIDE after tools", "SIDE answer"]);
      }
      await actual.session.prompt("MAIN next");
      await control.session.prompt("MAIN first");
      await control.session.prompt("MAIN next");
      // Independent QuickJS executions have different wall times. Normalize
      // only that runtime-generated timing line; /btw replay above stays exact.
      const withoutRuntimeTiming = request => {
        const copy = structuredClone(request);
        for (const item of copy.input) {
          if (item.type === "custom_tool_call_output") {
            item.output = item.output.replace(/^Wall time [0-9.]+ seconds$/m, "Wall time <runtime> seconds");
          }
        }
        return copy;
      };
      assert.deepEqual(withoutRuntimeTiming(actual.requests[3]), withoutRuntimeTiming(control.requests[2]));
      assert.deepEqual(actual.errors, []);
      assert.deepEqual(direct.errors, []);
      assert.deepEqual(control.errors, []);
    } finally { await direct.close(); await actual.close(); await control.close(); }
  });
}

test("Pi session tree navigation clears the old replay and the next request restores it", async () => {
  const h = await harness("openai-responses");
  try {
    await h.session.prompt("MAIN first");
    const user = h.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
    const navigation = await h.session.navigateTree(user.id, { summarize: false });
    assert.equal(navigation.cancelled, false);
    await h.session.prompt("/btw stale");
    assert.match(h.notices.at(-1).message, /no main request yet/);
    assert.equal(h.requests.length, 1);
    await h.session.prompt("MAIN on new path");
    await h.session.prompt("/btw fresh");
    assertReplay(h.requests[1], h.requests[2], "openai-responses", "fresh");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a main request continued after Pi's compact-and-retry is recorded without a new prompt", async () => {
  const h = await harness("openai-responses", { truncateAt: 1 });
  try {
    await h.session.prompt("MAIN first");
    // 0: the truncated main request, 1: the compaction summary, 2: the continued main request (no before_agent_start).
    assert.ok(h.manager.getEntries().some(entry => entry.type === "compaction"));
    assert.equal(h.requests.length, 3);
    await h.session.prompt("/btw after compaction");
    assertReplay(h.requests[2], h.requests[3], "openai-responses", "after compaction");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const [api, provider] of [["openai-responses", "openai"], ["openai-responses", "custom"],
  ["openai-completions", "custom"], ["openai-codex-responses", "openai-codex"],
  ["anthropic-messages", "custom"], ["google-generative-ai", "custom"]]) {
  test(`${provider}/${api}: exact replay, zero tool execution and unchanged next main request`, async () => {
    const actual = await harness(api, { provider });
    const control = await harness(api, { provider, plugin: false });
    try {
      await actual.session.prompt("/btw early");
      assert.match(actual.notices.at(-1).message, /no main request yet/);
      assert.equal(actual.requests.length, 0);
      await actual.session.prompt("MAIN first");
      const before = JSON.stringify(actual.manager.getEntries());
      const stateBefore = JSON.stringify(actual.session.messages);
      await actual.session.prompt("/btw SIDE QUESTION 🌲");
      assertReplay(actual.requests[0], actual.requests[1], api, "SIDE QUESTION 🌲");
      assert.equal(JSON.stringify(actual.manager.getEntries()), before);
      assert.equal(JSON.stringify(actual.session.messages), stateBefore);
      assert.equal(actual.executions(), 0);
      assert.deepEqual(actual.widgets.at(-1), ["/btw SIDE QUESTION 🌲", "SIDE answer"]);
      // Two side questions must both replay the main request, never each other.
      await actual.session.prompt("/btw SECOND SIDE");
      assertReplay(actual.requests[0], actual.requests[2], api, "SECOND SIDE");
      await actual.session.prompt("MAIN next");
      await control.session.prompt("MAIN first");
      await control.session.prompt("MAIN next");
      assert.deepEqual(actual.requests[3], control.requests[1]);
      for (const headers of [...actual.headers, ...control.headers]) {
        assert.equal(headers["x-model-probe"], "model-config-kept");
        assert.equal(headers["x-provider-probe"], "provider-config-kept");
        if (api === "openai-codex-responses") {
          assert.equal(headers["chatgpt-account-id"], "btw-test-account");
          assert.equal(headers["session-id"], "btw-test-session");
          assert.equal(headers.authorization, `Bearer ${offlineOAuth().access}`);
        } else assert.equal(authHeader(api, headers), "offline-scripted-test");
      }
      actual.nativeIntact();
      control.nativeIntact();
      assert.equal(actual.payloadHooks(), 4);
      assert.deepEqual(actual.errors, []);
      assert.deepEqual(control.errors, []);
    } finally { await actual.close(); await control.close(); }
  });

  test(`${provider}/${api}: side answer while main stream is open`, async () => {
    const h = await harness(api, { provider, holdMain: true });
    let main;
    try {
      main = h.session.prompt("MAIN streaming");
      await h.mainReady;
      assert.equal(h.session.isStreaming, true);
      const entries = JSON.stringify(h.manager.getEntries());
      await h.session.prompt("/btw STREAM SIDE");
      assert.equal(h.session.isStreaming, true);
      assertReplay(h.requests[0], h.requests[1], api, "STREAM SIDE");
      assert.equal(JSON.stringify(h.manager.getEntries()), entries);
      assert.equal(h.executions(), 0);
      assert.deepEqual(h.widgets.at(-1), ["/btw STREAM SIDE", "SIDE answer"]);
      h.release();
      await main;
      assert.equal(h.session.isStreaming, false);
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      assert.equal(h.session.messages.at(-1).content[0].text, "MAIN answer");
      assert.deepEqual(h.errors, []);
    } finally { h.release(); if (main) await main; await h.close(); }
  });
}

test("Pi cache warming re-sends the main request with maxTokens 1; /btw keeps the main request", async () => {
  const api = "anthropic-messages";
  const h = await harness(api, { holdMain: 2, warm: true });
  let main;
  try {
    await h.session.prompt("MAIN first");
    main = h.session.prompt("MAIN second");
    await h.mainReady;
    for (const end = Date.now() + 5_000; h.requests.length < 3 && Date.now() < end;) await new Promise(done => setTimeout(done, 50));
    const [, held, warmed] = h.requests;
    assert.equal(warmed?.max_tokens, 1, "Pi's cache warmer must have re-sent the held request");
    assert.deepEqual(canonical(api, { ...warmed, max_tokens: held.max_tokens }), canonical(api, held));
    await h.session.prompt("/btw after warming");
    assertReplay(held, h.requests[3], api, "after warming");
    assert.equal(h.requests[3].max_tokens, 1000);
    assert.equal(h.executions(), 0);
    h.release();
    await main;
    assert.deepEqual(h.errors, []);
  } finally { h.release(); if (main) await main; await h.close(); }
});

test("native Codex side requests resolve the current OAuth account through the host", async () => {
  const h = await harness("openai-codex-responses", { provider: "openai-codex" });
  try {
    await h.session.prompt("MAIN account A");
    await h.rotateAccount("btw-test-account-B");
    await h.session.prompt("/btw account B");
    assertReplay(h.requests[0], h.requests[1], "openai-codex-responses", "account B");
    assert.equal(h.headers[0]["chatgpt-account-id"], "btw-test-account");
    assert.equal(h.headers[1]["chatgpt-account-id"], "btw-test-account-B");
    assert.equal(h.headers[1].authorization, `Bearer ${offlineOAuth("btw-test-account-B").access}`);
    h.nativeIntact();
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const holdMain of [false, true]) {
  test(`native Codex WebSocket ${holdMain ? "streaming" : "idle"}: side SSE preserves the main connection`, async () => {
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocket;
    const api = "openai-codex-responses";
    const options = { provider: "openai-codex", transport: "websocket-cached" };
    let h, main;
    try {
      h = await harness(api, { ...options, holdMain });
      main = h.session.prompt("MAIN websocket");
      if (holdMain) await h.mainReady;
      else await main;
      const state = JSON.stringify(h.manager.getEntries());
      const stats = structuredClone(getOpenAICodexWebSocketDebugStats("btw-test-session"));
      await h.session.prompt("/btw separate stream");
      assertReplay(h.requests[0], h.requests[1], api, "separate stream");
      assert.deepEqual(h.transports, ["websocket", "sse"]);
      assert.equal(h.session.isStreaming, holdMain);
      assert.equal(JSON.stringify(h.manager.getEntries()), state);
      assert.deepEqual(getOpenAICodexWebSocketDebugStats("btw-test-session"), stats);
      assert.equal(h.executions(), 0);
      assert.deepEqual(h.widgets.at(-1), ["/btw separate stream", "SIDE answer"]);
      h.release(); await main;
      assert.equal(h.session.messages.at(-1).stopReason, "stop");
      await h.session.prompt("MAIN after websocket");
      const next = h.requests[2];
      assert.deepEqual(h.transports, ["websocket", "sse", "websocket"]);
      h.nativeIntact();
      await h.close(); h = undefined;
      const control = await harness(api, { ...options, plugin: false });
      try {
        await control.session.prompt("MAIN websocket");
        await control.session.prompt("MAIN after websocket");
        assert.deepEqual(next, control.requests[1]);
      } finally { await control.close(); }
    } finally {
      if (h) { h.release(); if (main) await main; await h.close(); }
      globalThis.WebSocket = previousWebSocket;
    }
  });
}
