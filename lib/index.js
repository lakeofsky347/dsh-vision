// src/index.ts
import {
  contentHasImage,
  createUserMessage,
  deepFreeze
} from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
var name = "dsh-vision";
var DEFAULTS = {
  provider: "xiaomi",
  model: "mimo-v2-omni",
  prompt: "\u8BF7\u8BE6\u7EC6\u63CF\u8FF0\u8FD9\u5F20\u56FE\u7247\u7684\u5185\u5BB9\uFF0C\u5305\u62EC\u4E3B\u4F53\u3001\u6587\u5B57\u3001\u5E03\u5C40\u3001\u989C\u8272\u7B49\u53EF\u89C2\u5BDF\u7EC6\u8282\uFF0C\u4F9B\u4E00\u4E2A\u65E0\u6CD5\u76F4\u63A5\u67E5\u770B\u56FE\u7247\u7684\u7EAF\u6587\u672C\u6A21\u578B\u7406\u89E3\u3002\u76F4\u63A5\u7ED9\u51FA\u63CF\u8FF0\uFF0C\u4E0D\u8981\u5BA2\u5957\u3002",
  cache: true
};
var Config = Schema.object({
  provider: Schema.string().default(DEFAULTS.provider),
  model: Schema.string().default(DEFAULTS.model),
  prompt: Schema.string().default(DEFAULTS.prompt),
  cache: Schema.boolean().default(DEFAULTS.cache),
  maxTokens: Schema.number()
});
function descriptionBlock(description) {
  return { type: "text", text: `[\u7528\u6237\u9644\u4EF6\u56FE\u7247\u7684\u89C6\u89C9\u63CF\u8FF0]
${description}` };
}
function visionRequest(cfg, images) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    messages: [
      createUserMessage({
        content: [...images, { type: "text", text: cfg.prompt }],
        source: { kind: "user" }
      })
    ],
    ...cfg.maxTokens === void 0 ? {} : { maxTokens: cfg.maxTokens }
  };
}
async function collectText(stream) {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "finish" && chunk.reason.kind === "error") {
      throw new Error(chunk.reason.failure.message);
    }
  }
  return text;
}
async function describeImages(llm, cfg, cache, ours, options, images) {
  const ids = images.map((block) => block.type === "image" ? String(block.attachment.attachmentId) : "").filter(Boolean).join(",");
  const key = `${String(options.sessionId ?? "")}:${ids}`;
  if (cfg.cache) {
    const hit = cache.get(key);
    if (hit !== void 0) return hit;
  }
  const request = visionRequest(cfg, images);
  ours.add(request);
  let text;
  try {
    text = await collectText(llm.stream(request));
  } catch (error) {
    return `(\u56FE\u7247\u63CF\u8FF0\u6682\u4E0D\u53EF\u7528: ${error instanceof Error ? error.message : String(error)})`;
  }
  const description = text.trim();
  if (cfg.cache && description.length > 0) cache.set(key, description);
  return description || "(\u56FE\u7247\u63CF\u8FF0\u4E3A\u7A7A)";
}
function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : ctx.llm;
  if (llm === void 0) return;
  const cache = /* @__PURE__ */ new Map();
  const ours = /* @__PURE__ */ new WeakSet();
  ctx.on("llm/stream", (options, next) => {
    if (ours.has(options)) return next();
    if (!options.messages.some((message) => contentHasImage(message.content))) return next();
    return (async function* () {
      const info = await llm.resolveModelInfo(options.provider, options.model).catch(() => void 0);
      if (info?.inputModalities?.includes("image")) {
        yield* next();
        return;
      }
      const messages = await Promise.all(
        options.messages.map(async (message) => {
          if (!contentHasImage(message.content)) return message;
          const images = message.content.filter((block) => block.type === "image");
          const description = await describeImages(llm, cfg, cache, ours, options, images);
          const textOnly = message.content.filter((block) => block.type !== "image");
          return deepFreeze({
            ...message,
            content: [...textOnly, descriptionBlock(description)]
          });
        })
      );
      yield* llm.stream(deepFreeze({ ...options, messages }));
    })();
  });
}
export {
  Config,
  apply,
  collectText,
  describeImages,
  name,
  visionRequest
};
//# sourceMappingURL=index.js.map
