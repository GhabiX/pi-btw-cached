# pi-btw-cached

English | [简体中文](README.zh-CN.md)

Ask Pi a side question while the main session works. `/btw is cartLine affected too?` shows an answer below the chat while the main session keeps running, and writes nothing to the session.

![/btw answers while the main session is still thinking](https://raw.githubusercontent.com/GhabiX/pi-btw-cached/main/media/btw.gif)

## Why it is built this way

A side question is the main session's latest request with one more user message at the end. pi-btw-cached sends that exact request and changes nothing else: system prompt, tool declarations, tool choice, history, model, thinking level, and prompt-cache key all stay as they were. This gives three properties:

- **Same context as the main session.** The model sees everything the main session has read and run up to that request, not a summary or a fresh chat.
- **Same cache prefix.** The side question starts with the exact prefix the next main turn would send, so providers that cache prompt prefixes can serve it from the main session's cache. (Cache hits and cost have not been measured on real providers yet.)
- **No per-provider request code.** Pi builds the request itself, so every chat API Pi supports works out of the box.

## Features

- Run `/btw <question>` at any time, including while the main session is streaming.
- Executes no tools and writes nothing to session history. The answer appears in a temporary widget and clears on compaction, tree navigation, or session switch.
- Works with OpenAI Responses and Chat Completions, Codex, Anthropic, Gemini, and every other chat API in Pi.
- Over Codex WebSocket, the side question uses a separate SSE request and leaves the main connection's continuation state untouched.

## Install

```sh
pi install npm:@spinejit/pi-btw-cached
```

Try it for one session without installing:

```sh
pi -e npm:@spinejit/pi-btw-cached
```

## Usage

Send a prompt in the main session, then ask:

```text
/btw why did you skip the integration tests?
```

The widget keeps the latest side question and answer. One side question runs at a time.

## How it works

1. **Record.** Pi exposes no public handle for the latest request. When a run starts, the extension wraps the active provider's `streamSimple` through Pi's public provider registration and records the `(model, transcript, options)` triple that Pi passes in—the same triple Pi's cache warmer re-sends. Every call is forwarded unchanged, and credentials, headers, and the abort signal are not kept.
2. **Only main session requests.** Compaction and summary requests carry different session IDs and are skipped. Every other request in the session is recorded, including ones Pi sends without a new prompt, such as the continue after compact-and-retry. Pi's cache warmer re-sends the same transcript with `maxTokens: 1`; that re-send does not overwrite the record.
3. **Ask.** `/btw` calls `ctx.modelRegistry.streamSimple(model, transcript + question, options)`. Pi serializes the request for the provider's API, resolves credentials for the current account, and runs the same `before_provider_request` hooks as the main session, so payload edits from other extensions apply to the side question too.
4. **No tools without touching the prefix.** Tool declarations and `tool_choice` stay untouched, because changing `tool_choice` invalidates Anthropic's message cache. Instead, the side question appends a short note asking for a text answer. If the model still requests a tool call, the widget shows the tool name and runs nothing.

The Codex SSE transport choice above is the only provider-specific branch in the extension.

## Limits

- Cache hits and cost savings are expected from the request design; they have not been measured on real providers.
- A side question does not carry the output of `before_provider_headers` hooks, because Pi merges it with credential headers before calling the provider. On Pi 1.3 the same applies to the attribution and session headers Pi adds for opencode, OpenRouter, NVIDIA, and Cloudflare.
- Interactive mode only. Side questions cannot be cancelled, and earlier answers are not kept.

## Compatibility

Tested with Pi 1.3.0 and 1.4.0 on Node 22.23. Requires Node >= 22.19. Pi's packages are `"*"` peer dependencies.

## Development

```sh
npm test
npm run typecheck
```

The test suite loads the extension through Pi's real extension loader and SDK, then runs Pi's API codecs against local scripted HTTP and WebSocket servers. It covers OpenAI Responses, Chat Completions, Codex (SSE and WebSocket), Anthropic, Gemini, codemode, and a re-send by Pi's own cache warmer. No credentials are read and no external model is called.

## More from @spinejit

- [pi-background-job](https://github.com/GhabiX/pi-background-job): background jobs and output monitors that wake the agent when events occur.
- [pi-timeout-policy](https://github.com/GhabiX/pi-timeout-policy): one timeout policy for bash, grep, and find.
- [pi-compact-tree](https://github.com/GhabiX/pi-compact-tree): a compact process tree for Pi's terminal UI.

## License

Apache-2.0. See [LICENSE](LICENSE).
