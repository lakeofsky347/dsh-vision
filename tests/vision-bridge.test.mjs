/**
 * dsh-vision logic tests.
 *
 * Drives the built plugin against a MINIATURE replica of the cordis
 * waterfall semantics (listeners run in order; `next()` passes the original
 * payload down; a listener may veto by returning its own value without
 * calling `next()`), plus a stub `ctx.llm`. This validates the bridge logic
 * without booting the harness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, visionRequest, collectText } from '../lib/index.js'

const VISION_TEXT = '这是一只趴在沙发上的橘猫，戴着红色项圈。'
const PROMPT = '请详细描述这张图片的内容，包括主体、文字、布局、颜色等可观察细节，供一个无法直接查看图片的纯文本模型理解。直接给出描述，不要客套。'

/** Build a test message object (plain shape accepted by the bridge). */
function userMessage(id, content) {
  return { id, role: 'user', source: { kind: 'user' }, content }
}

function imageBlock(attachmentId) {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType: 'image/png', bytes: 4, width: 10, height: 10 },
  }
}

/**
 * Miniature cordis waterfall over one plugin instance.
 *
 * @param models - map provider -> model -> inputModalities.
 * @param onTerminal - (options) => AsyncIterable<StreamChunk>; the adapter stand-in.
 */
function makeHarness(models, onTerminal) {
  const listeners = []
  // Mimic the real adapterStream: any adapter throw becomes an error finish
  // chunk instead of propagating out of the iteration.
  const safeTerminal = async function* (options) {
    try {
      yield* onTerminal(options)
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error.message, code: 'X' } } }
    }
  }
  const ctx = {
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    llm: {
      async resolveModelInfo(provider, model) {
        const found = models[provider]?.[model]
        if (found === undefined) throw new Error(`no model info for ${provider}/${model}`)
        return { provider, model, name: model, inputModalities: found }
      },
      stream(options) {
        const run = (i) =>
          i >= listeners.length ? safeTerminal(options) : listeners[i].listener(options, () => run(i + 1))
        return run(0)
      },
    },
  }
  apply(ctx, { provider: 'xiaomi', model: 'mimo-v2-omni', prompt: PROMPT })
  return ctx
}

/** Adapter stand-in: yields vision text for the vision route, records everything else. */
function terminalRecorder(seen, { failVision = false, visionDelayMs = 0 } = {}) {
  return async function* (options) {
    seen.push(options)
    if (options.provider === 'xiaomi') {
      if (visionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, visionDelayMs))
      if (failVision) throw new Error('xiaomi 502')
      yield { type: 'text-delta', index: 0, text: VISION_TEXT }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: '（deepseek 流）' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function imagesIn(options) {
  return options.messages.flatMap((m) => m.content.filter((b) => b.type === 'image'))
}

test('无图片的请求直接透传，next 立即调用', async () => {
  const seen = []
  const ctx = makeHarness(
    { 'deepseek-official': { 'deepseek-v4-pro': ['text'] } },
    terminalRecorder(seen),
  )
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: 's1',
    messages: [userMessage('m1', [{ type: 'text', text: '你好' }])],
  }
  const result = ctx.llm.stream(options)
  for await (const _ of result) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(seen[0], options)
})

test('纯文本模型 + 图片 → 视觉桥：mimo 被调用、请求中图片被替换为描述文本、且带缓存', async () => {
  const seen = []
  const ctx = makeHarness(
    {
      'deepseek-official': { 'deepseek-v4-pro': ['text'] },
      xiaomi: { 'mimo-v2-omni': ['text', 'image'] },
    },
    terminalRecorder(seen),
  )
  const image = imageBlock('att-1')
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: 's1',
    messages: [userMessage('m1', [{ type: 'text', text: '看这张图' }, image])],
  }
  const result = ctx.llm.stream(options)
  // 桥接路径：listener 返回惰性生成器（否决），需迭代才产生 mimo 调用
  const out = []
  for await (const chunk of result) out.push(chunk)
  assert.equal(out.some((c) => c.type === 'text-delta'), true)

  // 发生了两次终端调用：一次 xiaomi 视觉、一次 deepseek 桥接
  const visionCalls = seen.filter((o) => o.provider === 'xiaomi')
  const deepseekCalls = seen.filter((o) => o.provider === 'deepseek-official')
  assert.equal(visionCalls.length, 1)
  assert.equal(deepseekCalls.length, 1)

  // 视觉请求携带图片块 + 提示词
  const visionMsg = visionCalls[0].messages[0]
  assert.equal(visionMsg.role, 'user')
  assert.equal(imagesIn(visionCalls[0]).length, 1)
  assert.equal(visionMsg.content.some((b) => b.type === 'text' && b.text === PROMPT), true)

  // 桥接后的 deepseek 请求不含图片块，且包含 mimo 描述文本
  assert.equal(imagesIn(deepseekCalls[0]).length, 0)
  const bridgedText = deepseekCalls[0].messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(bridgedText.includes(VISION_TEXT), '桥接文本应包含 mimo 描述')
  assert.ok(bridgedText.includes('[用户附件图片的视觉描述]'))

  // 缓存：同一图片的第二次请求不再调用 mimo
  seen.length = 0
  const options2 = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: 's1',
    messages: [userMessage('m1', [{ type: 'text', text: '再看一次' }, image])],
  }
  for await (const _ of ctx.llm.stream(options2)) { /* drain */ }
  const visionCalls2 = seen.filter((o) => o.provider === 'xiaomi')
  assert.equal(visionCalls2.length, 0, '缓存命中后不应再次调用 mimo')
  const bridged2 = seen.find((o) => o.provider === 'deepseek-official')
  assert.ok(bridged2.messages[0].content.some((b) => b.type === 'text' && b.text.includes(VISION_TEXT)))
})

test('带视觉的模型（mimo 会话）→ 原生透传，图片保留', async () => {
  const seen = []
  const ctx = makeHarness(
    {
      xiaomi: { 'mimo-v2-omni': ['text', 'image'] },
    },
    terminalRecorder(seen),
  )
  const image = imageBlock('att-9')
  const options = {
    provider: 'xiaomi',
    model: 'mimo-v2-omni',
    sessionId: 's2',
    messages: [userMessage('m1', [{ type: 'text', text: '看图' }, image])],
  }
  for await (const _ of ctx.llm.stream(options)) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(seen[0], options, '原生路径应把原请求原样交给终端')
  assert.equal(imagesIn(seen[0]).length, 1)
})

test('视觉调用失败 → 优雅回退占位文本，deepseek 回合不中断', async () => {
  const seen = []
  const ctx = makeHarness(
    {
      'deepseek-official': { 'deepseek-v4-pro': ['text'] },
      xiaomi: { 'mimo-v2-omni': ['text', 'image'] },
    },
    terminalRecorder(seen, { failVision: true }),
  )
  const image = imageBlock('att-fail')
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: 's3',
    messages: [userMessage('m1', [image])],
  }
  const chunks = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  assert.equal(chunks.some((c) => c.type === 'text-delta'), true, 'deepseek 流仍应产出')
  const bridged = seen.find((o) => o.provider === 'deepseek-official')
  assert.equal(imagesIn(bridged).length, 0, '桥接请求必须无图片块')
  const text = bridged.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(text.includes('图片描述暂不可用'), `应含回退文案，实际: ${text.slice(0, 80)}`)
})

test('并发图像回合互不干扰（WeakSet 身份标记，无全局状态）', async () => {
  const seen = []
  const ctx = makeHarness(
    {
      'deepseek-official': { 'deepseek-v4-pro': ['text'] },
      xiaomi: { 'mimo-v2-omni': ['text', 'image'] },
    },
    terminalRecorder(seen, { visionDelayMs: 15 }),
  )
  const makeOptions = (sid, imageId, text) => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: sid,
    messages: [userMessage('m1', [{ type: 'text', text }, imageBlock(imageId)])],
  })
  // 两个会话的带图回合同时进行，视觉调用用 15ms 延迟强制交错
  const a = ctx.llm.stream(makeOptions('sA', 'att-a', '图A'))
  const b = ctx.llm.stream(makeOptions('sB', 'att-b', '图B'))
  await Promise.all([
    (async () => {
      for await (const _ of a) { /* drain */ }
    })(),
    (async () => {
      for await (const _ of b) { /* drain */ }
    })(),
  ])
  const deepseekCalls = seen.filter((o) => o.provider === 'deepseek-official')
  const visionCalls = seen.filter((o) => o.provider === 'xiaomi')
  assert.equal(visionCalls.length, 2, '两个视觉调用都应发生')
  assert.equal(deepseekCalls.length, 2, '两个桥接请求都应发生')
  for (const call of deepseekCalls) {
    assert.equal(imagesIn(call).length, 0, '每个桥接请求都必须无图片块')
  }
})

test('视觉路由未注册（NO_ADAPTER）→ 优雅回退，主回合不中断', async () => {
  const seen = []
  // 只注册 deepseek，不注册 xiaomi → 视觉调用在"适配器层"失败
  const ctx = makeHarness(
    { 'deepseek-official': { 'deepseek-v4-pro': ['text'] } },
    async function* (options) {
      seen.push(options)
      if (options.provider === 'xiaomi') throw new Error('no adapter registered for provider "xiaomi"')
      yield { type: 'text-delta', index: 0, text: '（deepseek 流）' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  )
  const image = imageBlock('att-noadapter')
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    sessionId: 's4',
    messages: [userMessage('m1', [image])],
  }
  const chunks = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  assert.equal(chunks.some((c) => c.type === 'text-delta'), true, 'deepseek 流仍应产出')
  const bridged = seen.find((o) => o.provider === 'deepseek-official')
  assert.equal(imagesIn(bridged).length, 0)
  const text = bridged.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(text.includes('图片描述暂不可用'), `应含回退文案，实际: ${text.slice(0, 100)}`)
})

test('visionRequest 与 collectText 纯函数', async () => {
  const cfg = { provider: 'xiaomi', model: 'mimo-v2-omni', prompt: PROMPT, cache: true }
  const image = imageBlock('att-2')
  const req = visionRequest(cfg, [image])
  assert.equal(req.provider, 'xiaomi')
  assert.equal(req.model, 'mimo-v2-omni')
  assert.equal(req.messages.length, 1)
  assert.equal(imagesIn(req).length, 1)

  const text = await collectText(
    (async function* () {
      yield { type: 'text-delta', index: 0, text: 'a' }
      yield { type: 'text-delta', index: 0, text: 'b' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  assert.equal(text, 'ab')

  await assert.rejects(
    collectText(
      (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
      })(),
    ),
    /boom/,
  )
})

function isAsyncIterable(value) {
  return value != null && typeof value[Symbol.asyncIterator] === 'function'
}
