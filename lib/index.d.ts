/**
 * dsh-vision — Vision Bridge for DeepSeek Harness.
 * Type declarations for the host-half plugin.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Plugin identity. */
export declare const name: 'dsh-vision'

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

/** Build the one-shot vision-model request carrying the image blocks plus the prompt. */
export declare function visionRequest(cfg: ResolvedConfig, images: ContentBlock[]): GenerateOptions

/** Consume a chunk stream and return the assembled visible text. */
export declare function collectText(stream: AsyncIterable<StreamChunk>): Promise<string>

/**
 * Describe one batch of image blocks through the vision model, memoized by
 * session + attachment ids. Failures degrade to a text placeholder.
 */
export declare function describeImages(
  ctx: Context,
  cfg: ResolvedConfig,
  cache: Map<string, string>,
  ours: WeakSet<GenerateOptions>,
  options: GenerateOptions,
  images: ContentBlock[],
): Promise<string>

/** Plugin body: register the `llm/stream` vision-bridge listener. */
export declare function apply(ctx: Context, config?: Config): void
