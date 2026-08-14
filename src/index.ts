/**
 * dsh-vision — Vision Bridge for DeepSeek Harness.
 *
 * Problem: the DeepSeek chat-completions adapter rejects image content
 * outright (`UNSUPPORTED_CONTENT`), so attaching an image in a DeepSeek
 * session fails the whole turn. The fix is a bridge: keep DeepSeek as the
 * reasoning brain, hand any attached images to a vision-capable model, and
 * feed the resulting text description back to DeepSeek.
 *
 * Mechanism — an `llm/stream` waterfall listener:
 *
 * - No image blocks in the request → `next()` unchanged (zero overhead).
 * - The routed model declares the `image` input modality → native vision,
 *   the request passes through untouched (e.g. a session routed to mimo
 *   sees images directly).
 * - Otherwise (text-only routed model) the listener VETOES the chain with a
 *   lazy async generator, because modality resolution is async and the loop
 *   consumes the waterfall result as an AsyncIterable, not a Promise:
 *     1. resolve the routed model's input modalities,
 *     2. for every message carrying image blocks, call the configured vision
 *        provider/model once (memoized per session + attachment ids),
 *     3. rebuild the request with each image block replaced by a
 *        `[用户附件图片的视觉描述]` text block,
 *     4. re-enter `ctx.llm.stream()` with the bridged request (a re-entry
 *        flag makes the listener pass our own calls straight through).
 *
 * The description is memoized so history replay on later turns reuses the
 * text instead of re-billing a vision call. A vision failure degrades to a
 * text placeholder, so the DeepSeek turn never fails because of the bridge.
 *
 * Re-entry control: our own vision requests are tagged in a WeakSet and pass
 * the listener straight through — no global "bridging" flag, so concurrent
 * image-carrying turns (parallel steps, multiple sessions) can never
 * interfere with each other. The bridged request carries no image blocks, so
 * it naturally passes the listener's image check on its own.
 */

import { Context } from '@deepseek-ai/cordis'
import {
  contentHasImage,
  createUserMessage,
  deepFreeze,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Plugin identity; the profile patch row mounts `@deepseek-ai/dsh-vision`. */
export const name = 'dsh-vision'

/** Plugin configuration; every field is optional. */
export interface Config {
  /** Vision provider route the bridge calls. Defaults to `xiaomi`. */
  provider?: string
  /** Vision model id on that route. Defaults to `mimo-v2-omni`. */
  model?: string
  /** Instruction sent beside the images to the vision model. */
  prompt?: string
  /** Memoize descriptions per (session, attachments). Defaults to true. */
  cache?: boolean
  /** Optional output token cap for the vision call. */
  maxTokens?: number
}

/** Resolved configuration with every field populated. */
export interface ResolvedConfig {
  provider: string
  model: string
  prompt: string
  cache: boolean
  maxTokens?: number
}

const DEFAULTS = {
  provider: 'xiaomi',
  model: 'mimo-v2-omni',
  prompt:
    '请详细描述这张图片的内容，包括主体、文字、布局、颜色等可观察细节，供一个无法直接查看图片的纯文本模型理解。直接给出描述，不要客套。',
  cache: true,
} as const

/** Text block replacing image blocks inside a bridged message. */
function descriptionBlock(description: string): ContentBlock {
  return { type: 'text', text: `[用户附件图片的视觉描述]\n${description}` }
}

/** Build the one-shot vision-model request carrying the image blocks plus the prompt. */
export function visionRequest(cfg: ResolvedConfig, images: ContentBlock[]): GenerateOptions {
  return {
    provider: cfg.provider,
    model: cfg.model,
    messages: [
      createUserMessage({
        content: [...images, { type: 'text', text: cfg.prompt }],
        source: { kind: 'user' },
      }),
    ],
    ...(cfg.maxTokens === undefined ? {} : { maxTokens: cfg.maxTokens }),
  }
}

/** Consume a chunk stream and return the assembled visible text. */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error(chunk.reason.failure.message)
    }
  }
  return text
}

/**
 * Describe one batch of image blocks through the vision model, memoized by
 * session + attachment ids. Failures degrade to a text placeholder.
 *
 * The returned vision request is tagged in `ours` so the plugin's own
 * `llm/stream` listener lets it pass straight through to the adapter (which
 * performs its own modality check).
 */
export async function describeImages(
  llm: Pick<Context['llm'], 'stream'>,
  cfg: ResolvedConfig,
  cache: Map<string, string>,
  ours: WeakSet<GenerateOptions>,
  options: GenerateOptions,
  images: ContentBlock[],
): Promise<string> {
  const ids = images
    .map((block) => (block.type === 'image' ? String(block.attachment.attachmentId) : ''))
    .filter(Boolean)
    .join(',')
  const key = `${String(options.sessionId ?? '')}:${ids}`
  if (cfg.cache) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }
  const request = visionRequest(cfg, images)
  ours.add(request)
  let text: string
  try {
    text = await collectText(llm.stream(request))
  } catch (error) {
    return `(图片描述暂不可用: ${error instanceof Error ? error.message : String(error)})`
  }
  const description = text.trim()
  if (cfg.cache && description.length > 0) cache.set(key, description)
  return description || '(图片描述为空)'
}

/** Plugin body: register the `llm/stream` vision-bridge listener. */
export function apply(ctx: Context, config: Config = {}): void {
  const cfg: ResolvedConfig = { ...DEFAULTS, ...config }
  // Resolve the llm service on this context once. Under the harness's
  // restricted Context, property access via `ctx.llm` inside deferred
  // waterfall callbacks throws `cannot get property "llm" without inject`;
  // the idiomatic access is `ctx.get('llm')`. The offline test harness builds
  // a plain object context that carries `ctx.llm` directly and no `ctx.get`,
  // so fall back to that shape when `ctx.get` is absent.
  const llm = (typeof (ctx as { get?: unknown }).get === 'function'
    ? (ctx as { get(name: string): unknown }).get('llm')
    : (ctx as { llm?: unknown }).llm) as Context['llm'] | undefined
  if (llm === undefined) return
  const cache = new Map<string, string>()
  const ours = new WeakSet<GenerateOptions>()

  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    // Our own vision request → the adapter decides; never bridge ourselves.
    if (ours.has(options)) return next()
    // No image blocks anywhere in this request → nothing to do.
    if (!options.messages.some((message) => contentHasImage(message.content))) return next()
    // Veto with a lazy generator: modality resolution is async, but the loop
    // consumes the waterfall result as an AsyncIterable — never a Promise.
    return (async function* () {
      const info = await llm
        .resolveModelInfo(options.provider, options.model)
        .catch(() => undefined)
      // The routed model already accepts images → native vision, untouched.
      if (info?.inputModalities?.includes('image')) {
        yield* next()
        return
      }
      const messages = await Promise.all(
        options.messages.map(async (message): Promise<Message> => {
          if (!contentHasImage(message.content)) return message
          const images = message.content.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image')
          const description = await describeImages(llm, cfg, cache, ours, options, images)
          const textOnly = message.content.filter((block) => block.type !== 'image')
          return deepFreeze({
            ...message,
            content: [...textOnly, descriptionBlock(description)],
          })
        }),
      )
      // The bridged request carries no image blocks, so it passes the
      // listener's image check on its own — no re-entry flag needed.
      yield* llm.stream(deepFreeze({ ...options, messages }))
    })()
  })
}
