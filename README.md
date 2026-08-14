# dsh-vision — 识图路由插件（Vision Bridge for DeepSeek Harness）

让纯文本路由的 DeepSeek 会话也能"看图"：把用户附件中的图片交给视觉模型
（默认 `xiaomi/mimo-v2-omni`）生成文字描述，再以文本块回填给 DeepSeek，
避免 `UNSUPPORTED_CONTENT` 使整轮失败。

本包按 [DeepSeek Harness 插件发布规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
打包为 **bundle**：`package.json` 声明 `dsh.bundle`，随包携带 `cordis.patch.yml`
配置层，安装进 profile 后自动插入插件行。

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
视觉调用失败时降级为占位文本，DeepSeek 回合不因桥接而中断。
并发带图回合通过 `WeakSet` 身份标记隔离，无全局状态，互不干扰。

## 构建与测试

```sh
npm install
npm run build   # esbuild 生成 lib/index.js（external @deepseek-ai/*）
npm test        # node --test，离线 mini-cordis 瀑布模型验证桥接逻辑
```

`prepare` 脚本在 git 安装 / `npm pack` / 发布时自动执行构建，保证源码检出
即可用（无需仓库外上下文）。

## 安装到 profile

本包是 bundle（声明了 `dsh.bundle`），按官方发布规范安装：

```sh
# 本地 checkout（开发）
dsh plugin --profile web add ./dsh-vision

# 从 GitHub 安装（源码检出，pnpm 会执行 prepare 构建）
dsh plugin --profile web add github:lakeofsky347/dsh-vision

# 或发布/打包后安装预构建产物（无需任何构建权限）
npm pack
dsh plugin --profile web add ./dsh-vision-0.1.0.tgz
```

> **pnpm ≥ 10**：git 依赖的 `prepare` 脚本默认被禁止，首次 `add` 会失败并
> 打印提示；把报错中的包 key 加入 profile 的 `pnpm-workspace.yaml`
> （`allowBuilds.dsh-vision: true`）后重新 `add`。请只允许信任来源的包，
> 并固定提交（`github:lakeofsky347/dsh-vision#<sha>`）。

`dsh plugin add` 会把 bundle 追加进 `dsh.profile.bundles`，其
`cordis.patch.yml` 插入插件行：

```yaml
- insert:
    - id: vision
      name: dsh-vision
```

行内不写配置，默认值由插件的 Schemastery `Config` schema 填充。部署环境在
自己的 `~/.dsh/profiles/<name>/cordis.patch.yml` 里按 `id` 覆盖整行 config
（patch 替换整份 config，不做深合并）：

```yaml
- id: vision
  name: dsh-vision
  config:
    provider: xiaomi-token-plan-cn
    model: mimo-v2.5
```

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `xiaomi` | 视觉模型所在的路由 |
| `model` | `mimo-v2-omni` | 视觉模型 id |
| `prompt` | （见 `src/index.ts`） | 随图发给视觉模型的指令 |
| `cache` | `true` | 是否按 (session, 附件) 记忆化描述 |
| `maxTokens` | — | 视觉调用输出 token 上限（可省略） |

## 目录

```
src/index.ts       插件源码（监听器 + 桥接逻辑 + Config schema）
scripts/build.mjs  esbuild 构建脚本（build / prepare）
tests/             node:test 逻辑测试（mini-cordis 瀑布 + stub llm）
cordis.patch.yml   bundle 配置层（dsh.bundle 指向）
lib/               构建产物（DSH loader 消费 host half）
LICENSE            MIT
```

## License

MIT
