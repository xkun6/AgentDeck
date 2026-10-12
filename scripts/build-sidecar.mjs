#!/usr/bin/env node
// 用 esbuild 把 packages/sidecar/src/main.ts 打成单文件 dist-sidecar/bundle.mjs（design.md 7.1）。
// 打包态由 Rust 以 `<exe 目录>/node.exe <resource_dir>/sidecar/bundle.mjs` 拉起，旁边没有 node_modules，
// 所以除可选原生加速包与 claude-agent-sdk 平台二进制外，全部依赖都必须打进 bundle。
//
// 用法：node scripts/build-sidecar.mjs（或 pnpm sidecar:build）

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(repoRoot, "packages", "sidecar");
const outfile = resolve(repoRoot, "dist-sidecar", "bundle.mjs");

// esbuild 是 @agentdeck/sidecar 的 devDependency，从该包解析
const { build } = createRequire(resolve(sidecarDir, "package.json"))("esbuild");

// 源码用 `createRequire(import.meta.url)` 加载 which，esbuild 不会跟踪这种 require，
// 打包时把它改写成静态 import，让 which 进入 bundle。源码改成静态 import 后此插件自动失效。
const inlineCreateRequireWhich = {
  name: "inline-create-require-which",
  setup(builder) {
    builder.onLoad({ filter: /executable-resolution[\\/]executable-resolution\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const pattern = 'const which = require("which") as Which;';
      if (!source.includes('require("which")')) return undefined;
      if (!source.includes(pattern)) {
        throw new Error(`${args.path} 中 require("which") 的写法变了，请同步更新 build-sidecar.mjs`);
      }
      const contents =
        'import __bundledWhich from "which";\n' +
        source.replace(pattern, "const which = __bundledWhich as unknown as Which;");
      return { contents, loader: "ts" };
    });
  },
};

const result = await build({
  absWorkingDir: sidecarDir,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // ESM 输出里打进来的 CJS 依赖需要真实的 require
  banner: {
    js: 'import { createRequire as __agentdeckCreateRequire } from "node:module"; const require = __agentdeckCreateRequire(import.meta.url);',
  },
  external: ["bufferutil", "utf-8-validate", "@anthropic-ai/claude-agent-sdk-*"],
  plugins: [inlineCreateRequireWhich],
  logLevel: "warning",
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs).length;
const size = statSync(outfile).size;
console.log(
  `[build-sidecar] ${outfile}（${(size / 1024 / 1024).toFixed(2)} MB，${inputs} 个输入模块）`,
);
