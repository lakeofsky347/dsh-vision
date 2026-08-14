# dsh-vision — 识图路由插件（Vision Bridge for DeepSeek Harness）

让纯文本路由的 DeepSeek 会话也能"看图"：把用户附件中的图片交给视觉模型
（默认 `xiaomi/mimo-v2-omni`）生成文字描述，再以文本块回填给 DeepSeek，
避免 `UNSUPPORTED_CONTENT` 使整轮失败。

## 工作原理

在 `llm/stream` waterfall 上注册监听器：

- 请求中无图片块 → `next()` 原样透传（零开销）。
- 路由模型声明了 `image` 输入模态 → 原生视觉，请求原样放行（例如路由到
  mimo 的会话直接看图）。
- 其余情况（纯文本模型 + 图片）→ 监听器否决链并返回惰性异步生成器：

  1. 解析路由模型的输入模态；
  2. 对每个携带图片块的消息调用一次视觉模型（按 session + 附件 id 记忆化）；
  3. 将图片块替换为 `[用户附件图片的视觉描述]` 文本块后重建请求；
  4. 带重入标记重新进入 `ctx.llm.stream()`，桥接请求自身不再触发监听。

描述按 (session, 附件) 记忆化，历史回放复用文本而不是重复计费视觉调用；
视觉调用失败时优雅降级为占位文本，DeepSeek 回合永不因桥接而中断。
并发带图回合通过 `WeakSet` 身份标记隔离，无全局状态，互不干扰。

## 使用

```sh
npm install
npm run build   # 生成 lib/index.js（esbuild，external @deepseek-ai/*）
npm test        # node --test，离线 mini-cordis 瀑布模型验证桥接逻辑
```

在 DSH 的 cordis 配置中挂载本插件（`@deepseek-ai/dsh-vision` 行），可配置项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `xiaomi` | 视觉模型所在的路由 |
| `model` | `mimo-v2-omni` | 视觉模型 id |
| `prompt` | （见 `src/index.ts`） | 随图发给视觉模型的指令 |
| `cache` | `true` | 是否按 (session, 附件) 记忆化描述 |
| `maxTokens` | — | 视觉调用输出 token 上限 |

## 目录

```
src/index.ts       插件源码（监听器 + 桥接逻辑）
scripts/build.mjs  esbuild 构建脚本
tests/             node:test 逻辑测试（mini-cordis 瀑布 + stub llm）
lib/               构建产物（DSH loader 消费 host half）
```

## License

MIT
