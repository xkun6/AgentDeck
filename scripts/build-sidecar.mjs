#!/usr/bin/env node
// 用 esbuild 把 packages/sidecar/src/main.ts 打成单文件 dist-sidecar/bundle.mjs（design.md 7.1）。
// 打包态由 Rust 以 `<exe 目录>/node.exe <resource_dir>/sidecar/bundle.mjs` 拉起，旁边没有 node_modules，
// 所以除 ws 的可选原生加速包（bufferutil / utf-8-validate）外，全部依赖都必须打进 bundle。
//
// 用法：node scripts/build-sidecar.mjs（或 pnpm sidecar:build）

import { statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(repoRoot, "packages", "sidecar");
const outfile = resolve(repoRoot, "dist-sidecar", "bundle.mjs");
// metafile 用于核对打进 bundle 的第三方包（NOTICE.md / legal/sidecar-third-party.txt）
const metafileOut = resolve(repoRoot, "dist-sidecar", "meta.json");

// esbuild 是 @agentdeck/sidecar 的 devDependency，从该包解析
const { build } = createRequire(resolve(sidecarDir, "package.json"))("esbuild");

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
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
  metafile: true,
});

writeFileSync(metafileOut, JSON.stringify(result.metafile, null, 2));

const inputs = Object.keys(result.metafile.inputs).length;
const size = statSync(outfile).size;
console.log(
  `[build-sidecar] ${outfile}（${(size / 1024 / 1024).toFixed(2)} MB，${inputs} 个输入模块）`,
);
