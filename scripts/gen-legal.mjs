#!/usr/bin/env node
// 生成随包分发的第三方许可声明（design.md 第 8 节）：
//   - legal/sidecar-third-party.txt：读 dist-sidecar/meta.json（scripts/build-sidecar.mjs 输出的
//     esbuild metafile），列出实际打进 sidecar bundle 的 npm 包及其许可原文；
//   - legal/web-third-party.txt：用 `pnpm licenses list --prod --json` 列出前端及其引用的
//     workspace 包的全部生产依赖，许可原文相同的包合并为一组。
// 输出只依赖依赖树与 metafile，重复运行结果不变。依赖或 sidecar bundle 变化后需重新运行。
//
// 用法：pnpm sidecar:build && node scripts/gen-legal.mjs（或 pnpm legal:gen）

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = resolve(repoRoot, "packages", "sidecar");
const metafile = resolve(repoRoot, "dist-sidecar", "meta.json");
const WEB_FILTERS = ["@agentdeck/web", "@agentdeck/protocol", "@agentdeck/shared-ui"];
const SEP = "=".repeat(78);

/** 去 BOM、统一换行、去尾部空白。 */
const norm = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
const byNameVersion = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

function licenseFile(dir) {
  const files = readdirSync(dir).filter((n) => /^(licen[cs]e|copying)/i.test(n)).sort();
  return files.length ? join(dir, files[0]) : null;
}

function pkgJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function authorOf(pj) {
  const a = pj.author;
  if (!a) return "";
  return typeof a === "string" ? a : [a.name, a.email && `<${a.email}>`].filter(Boolean).join(" ");
}

function repoOf(pj) {
  const r = pj.repository;
  return pj.homepage || (typeof r === "string" ? r : r?.url) || "";
}

function writeLegal(name, lines) {
  writeFileSync(resolve(repoRoot, "legal", name), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- sidecar

function genSidecar() {
  if (!existsSync(metafile)) {
    throw new Error(`缺少 ${metafile}，请先运行 pnpm sidecar:build`);
  }
  const meta = JSON.parse(readFileSync(metafile, "utf8"));
  const dirs = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/.][^/]*)\//);
    if (m) dirs.add(resolve(sidecarDir, m[1]));
  }
  const pkgs = [...dirs]
    .map((dir) => {
      const pj = pkgJson(dir);
      return { dir, pj, name: pj.name, version: pj.version };
    })
    .sort(byNameVersion);

  const out = [
    "AgentDeck sidecar（dist-sidecar/bundle.mjs，安装后位于 <资源目录>/sidecar/bundle.mjs）第三方组件许可声明",
    "",
    "清单来源：scripts/build-sidecar.mjs 输出的 esbuild metafile（dist-sidecar/meta.json）中实际打进 bundle 的 npm 包。",
    "Node.js 内置模块与 external（bufferutil、utf-8-validate）不在 bundle 中，未列出。",
    "Claude Code 与 Codex 均调用用户本机安装的 CLI，bundle 中不包含 Anthropic / OpenAI 的代码或可执行文件。",
    "",
    "包清单（包名@版本 — 许可证）：",
  ];
  for (const { pj } of pkgs) out.push(`  - ${pj.name}@${pj.version} — ${pj.license}`);
  out.push("");
  for (const { dir, pj } of pkgs) {
    const file = licenseFile(dir);
    if (!file) throw new Error(`缺少许可文件：${pj.name}@${pj.version}（${dir}）`);
    out.push(SEP, `${pj.name}@${pj.version}`, `许可证：${pj.license}`);
    if (repoOf(pj)) out.push(`主页：${repoOf(pj)}`);
    out.push(`许可文件原文（${basename(file)}）：`, SEP, norm(readFileSync(file, "utf8")), "");
  }
  writeLegal("sidecar-third-party.txt", out);
  console.log(`[gen-legal] sidecar：${pkgs.map(({ pj }) => `${pj.name}@${pj.version} ${pj.license}`).join("，")}`);
}

// ---------------------------------------------------------------- web

function genWeb() {
  const filters = WEB_FILTERS.map((f) => `--filter ${f}`).join(" ");
  const json = execSync(`pnpm ${filters} licenses list --prod --json`, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const seen = new Set();
  const entries = [];
  for (const pkgs of Object.values(JSON.parse(json))) {
    for (const p of pkgs) {
      p.versions.forEach((version, i) => {
        const key = `${p.name}@${version}`;
        if (seen.has(key)) return;
        seen.add(key);
        const dir = p.paths[i] ?? p.paths[0];
        entries.push({ name: p.name, version, license: p.license, dir, pj: pkgJson(dir) });
      });
    }
  }
  entries.sort(byNameVersion);

  const groups = new Map();
  const missing = [];
  for (const e of entries) {
    const file = licenseFile(e.dir);
    if (!file) {
      missing.push(e);
      continue;
    }
    const text = norm(readFileSync(file, "utf8"));
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(e);
  }

  const out = [
    "AgentDeck 前端（web bundle，安装后内嵌于主程序）第三方组件许可声明",
    "",
    `清单来源：pnpm ${filters} licenses list --prod --json`,
    "范围：前端及其引用的 workspace 包（@agentdeck/protocol、@agentdeck/shared-ui）的全部生产依赖（含传递依赖）。",
    "这是依赖树层面的清单，可能多于经 Vite tree-shaking 后实际打进 bundle 的代码。",
    `共 ${entries.length} 个包版本。`,
    "",
    "一、包清单（包名@版本 — 许可证）",
    "",
  ];
  for (const e of entries) out.push(`  - ${e.name}@${e.version} — ${e.license}`);
  out.push("", "二、许可原文（许可文件全文相同的包合并为一组，每组先列出适用的包，版权行见其后的许可原文）", "");
  for (const [text, es] of groups) {
    out.push(SEP, "适用于：");
    for (const e of es) out.push(`  - ${e.name}@${e.version}（${e.license}）`);
    out.push(SEP, text, "");
  }
  out.push(SEP, "三、包内未附许可文件的包（按 package.json 声明的许可证适用；标准许可文本见上文同类条目）", SEP);
  for (const e of missing) {
    const extra = [authorOf(e.pj) && `作者：${authorOf(e.pj)}`, repoOf(e.pj) && `主页：${repoOf(e.pj)}`]
      .filter(Boolean)
      .join("；");
    out.push(`  - ${e.name}@${e.version} — ${e.license}${extra ? `；${extra}` : ""}`);
  }
  out.push("");
  writeLegal("web-third-party.txt", out);
  console.log(`[gen-legal] web：${entries.length} 个包版本，${groups.size} 组许可原文，${missing.length} 个未附许可文件`);
}

try {
  genSidecar();
  genWeb();
} catch (error) {
  console.error(`[gen-legal] ${error.message}`);
  process.exit(1);
}
