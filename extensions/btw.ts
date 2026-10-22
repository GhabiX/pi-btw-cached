import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type OnPayload = NonNullable<SimpleStreamOptions["onPayload"]>;

/**
 * The latest main-session request as Pi handed it to the provider: the same
 * triple Pi's own cache warmer re-sends. Credentials, headers and the signal
 * are left out; the host resolves them again for the side request. Stream
 * observers are left out too, since the side request is not session traffic.
 */
interface MainRequest {
  model: Model<Api>;
  messages: Message[];
  options: SimpleStreamOptions;
  sessionId: string;
}

const NO_REQUEST = "no main request yet; send a prompt in the main session first.";

// Appended to the question so the model answers in text. Tools stay declared
// and tool_choice stays as the main request had it: changing either would
// break the cached prefix (Anthropic re-keys the message cache on tool_choice).
const sideQuestion = (question: string) =>
  `${question}\n\n(Side question: answer from the conversation so far. Tools are unavailable here, so do not call any.)`;

export default function btw(pi: ExtensionAPI): void {
  let latest: MainRequest | undefined;
  let latestMessages: unknown;
  let busy = false;
  let epoch = 0;
  let activeSession: string | undefined;
  const wrapped = new WeakSet<StreamSimple>();
  const sideCallbacks = new WeakSet<OnPayload>();

  // Every session change (start, reload, resume, new, fork) emits session_start; tree
  // navigation and compaction keep the session id. Main requests carry that id, including
  // ones Pi sends without a new prompt, such as the continue after compact-and-retry.
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    latest = undefined;
    latestMessages = undefined;
    activeSession = ctx.sessionManager.getSessionId();
    epoch++;
    ctx.ui.setWidget("btw-lite", undefined);
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);

  // Pi has no public handle on the latest request, so observe it at the
  // provider entry. The wrapper only records; it forwards every call unchanged.
  pi.on("before_agent_start", (_event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const id = model.provider;
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id);
    const registration = ctx.modelRegistry.getRegisteredProviderConfig(id);
    if (native && wrapped.has(native.streamSimple)) return;
    if (registration && registration.api === model.api && registration.streamSimple && wrapped.has(registration.streamSimple)) return;
    // Decorate the raw native provider, so models.json overlays are applied once
    // by the host. Named registrations instead retain their existing config.
    const provider = native ?? ctx.modelRegistry.getProvider(id);
    if (!provider) return;
    const decorated: StreamSimple = (model, context, options) => {
      // Compaction and summaries use other session ids; side requests carry a
      // marked callback. Pi's cache warmer re-sends the same messages array with
      // maxTokens 1; that is not a new main request, so the first send stays.
      if (options && activeSession && options.sessionId === activeSession && !(options.onPayload && sideCallbacks.has(options.onPayload))
        && context.messages !== latestMessages) {
        const { signal, apiKey, headers, env, onResponse, onProviderStreamEvent, ...rest } = options;
        latestMessages = context.messages;
        latest = { model: structuredClone(model), messages: [...context.messages], options: rest, sessionId: activeSession };
      }
      return provider.streamSimple(model, context, options);
    };
    wrapped.add(decorated);
    if (native) pi.registerProvider({ ...native, streamSimple: decorated });
    else pi.registerProvider(id, { api: model.api, streamSimple: decorated });
  });

  pi.registerCommand("btw", {
    description: "Ask a side question about the main session (runs no tools, not saved to history)",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) return ctx.ui.notify("Usage: /btw <question>", "info");
      if (!ctx.hasUI) return ctx.ui.notify("/btw needs the interactive UI.", "warning");
      if (!latest || latest.sessionId !== ctx.sessionManager.getSessionId()) return ctx.ui.notify(`/btw: ${NO_REQUEST}`, "warning");
      if (busy) return ctx.ui.notify("/btw: the previous side question is still being answered.", "info");
      const main = latest;
      const answerEpoch = epoch;
      busy = true;
      ctx.ui.setWidget("btw-lite", [`/btw ${question}`, "answering…"]);
      try {
        // Same payload hooks as the main request, so the prefix matches; marked
        // so the provider wrapper does not record this request as the main one.
        const hooks = main.options.onPayload;
        const onPayload: OnPayload = (payload, model) => hooks?.(payload, model);
        sideCallbacks.add(onPayload);
        const answer = await ctx.modelRegistry.streamSimple(main.model, {
          messages: [...main.messages, { role: "user", content: sideQuestion(question), timestamp: Date.now() }],
        }, {
          ...main.options, onPayload,
          // Codex WebSocket continuation belongs to the main conversation.
          // A side request must not replace its connection-scoped response state.
          ...(main.model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
        }).result();
        if (answerEpoch !== epoch) return;
        if (answer.stopReason === "error" || answer.stopReason === "aborted") {
          throw new Error(answer.errorMessage ?? "side request failed.");
        }
        const text = answer.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const calls = answer.content.filter(part => part.type === "toolCall").map(part => part.name);
        const shown = text || (calls.length ? `(no text answer; the model asked to call ${calls.join(", ")}, which /btw does not run)` : "(no text answer)");
        ctx.ui.setWidget("btw-lite", [`/btw ${question}`, ...shown.split("\n")]);
      } catch (error) {
        if (answerEpoch === epoch) ctx.ui.setWidget("btw-lite", [`/btw ${question}`, `failed: ${error instanceof Error ? error.message : String(error)}`]);
      } finally {
        busy = false;
      }
    },
  });
}
