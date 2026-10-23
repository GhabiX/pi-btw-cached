# pi-btw-cached

[English](README.md) | 简体中文

在主会话运行期间随时向 Pi 提一个侧问。输入 `/btw cartLine 也受影响吗？` 后，回答会直接显示在聊天区下方，主会话继续执行，会话历史里不会留下任何记录。

![主会话还在思考，/btw 已经回答](https://raw.githubusercontent.com/GhabiX/pi-btw-cached/main/media/btw.gif)

## 为什么这样设计

侧问就是在主会话最近一次请求的末尾追加一条 user 消息。pi-btw-cached 原样发送这份请求，其余参数一概不改：system prompt、工具声明、tool choice、对话历史、模型、思考等级和 prompt cache key 均保持不变。这样设计有三个直接结果：

- **与主会话共享同一份上下文。** 模型看到的是主会话截至该次请求读过、执行过的全部内容，而不是摘要或新开的对话。
- **复用同一缓存前缀。** 侧问请求的前缀与主会话下一轮将发送的前缀完全一致，支持前缀缓存的服务商可以复用主会话的缓存。（真实服务上的缓存命中率和费用尚未实测。）
- **无需按服务商编写适配代码。** 请求由 Pi 自行组装，Pi 支持的所有聊天 API 均可直接使用。

## 特性

- 随时可用 `/btw <问题>` 提问，主会话正在流式输出时也不受影响。
- 不执行工具，也不写入会话历史。回答显示在临时 widget 中，会话压缩、切换会话树或切换会话时自动清空。
- 支持 OpenAI Responses 和 Chat Completions、Codex、Anthropic、Gemini 以及 Pi 中的其他聊天 API。
- Codex 使用 WebSocket 时，侧问单独发起一个 SSE 请求，不改动主连接的续接状态。

## 安装

```sh
pi install npm:@spinejit/pi-btw-cached
```

不安装，仅在当前会话中试用：

```sh
pi -e npm:@spinejit/pi-btw-cached
```

## 用法

先在主会话中发送一条消息，再提问：

```text
/btw 为什么跳过了集成测试？
```

widget 只保留最新一条侧问和回答。同一时间只运行一个侧问。

## 原理

1. **记录。** Pi 没有公开获取"最近一次请求"的接口。每次运行开始时，插件通过 Pi 公开的 provider 注册接口包装当前 provider 的 `streamSimple`，记下 Pi 传入的 `(model, transcript, options)` 三元组——Pi 自带的 cache warmer 重发的也是这三项。所有调用均原样转发，不保存凭据、headers 和取消信号。
2. **只记主请求。** 压缩和摘要请求使用不同的 session id，直接跳过。会话里其他请求都会记下，包括 Pi 不经新提问自己发出的请求，例如压缩后重试的那次。Pi 的 cache warmer 以 `maxTokens: 1` 重发同一份 transcript，这次重发不会覆盖已有记录。
3. **提问。** `/btw` 调用 `ctx.modelRegistry.streamSimple(model, transcript + 问题, options)`。Pi 负责按当前 provider 的 API 序列化请求、解析当前账号凭据，并执行与主会话相同的 `before_provider_request` 钩子，因此其他扩展对请求体的修改在侧问上同样生效。
4. **不执行工具，也不动前缀。** 工具声明和 `tool_choice` 保持原样，因为修改 `tool_choice` 会使 Anthropic 的消息缓存失效。问题末尾会附一句说明，请模型直接用文字作答。若模型仍试图调用工具，widget 只会写出工具名，不会实际执行。

除上述 Codex 传输方式外，插件没有任何按服务商分支的代码。

## 限制

- 缓存命中和费用节省是请求结构带来的预期结果，尚未在真实服务商上实测。
- 侧问不会携带 `before_provider_headers` 钩子的输出，因为它在传给 provider 之前已与凭据 headers 合并。在 Pi 1.3 上，Pi 为 opencode、OpenRouter、NVIDIA、Cloudflare 附加的归属和会话 headers 也是这样。
- 仅支持交互模式。不支持取消侧问，也不保留历史回答。

## 兼容性

已在 Pi 1.3.0 和 1.4.0、Node 22.23 下测试通过。要求 Node >= 22.19。Pi 相关包均声明为 `"*"` peer dependencies。

## 开发

```sh
npm test
npm run typecheck
```

测试通过 Pi 真实的扩展加载器和 SDK 加载插件，并使用 Pi 自带的各 API 编解码器连接本地脚本化 HTTP 和 WebSocket 服务，覆盖 OpenAI Responses、Chat Completions、Codex（SSE 和 WebSocket）、Anthropic、Gemini、codemode，以及 Pi 自带 cache warmer 的一次重发。测试不读取凭据，也不调用真实模型。

## @spinejit 的其他插件

- [pi-background-job](https://github.com/GhabiX/pi-background-job)：后台任务与输出监视，事件发生时自动通知 agent。
- [pi-timeout-policy](https://github.com/GhabiX/pi-timeout-policy)：为 bash、grep、find 提供统一的超时策略。
- [pi-compact-tree](https://github.com/GhabiX/pi-compact-tree)：Pi 终端界面的紧凑过程树视图。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
