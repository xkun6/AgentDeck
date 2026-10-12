#!/usr/bin/env node
// 下载固定版本的官方 Node 运行时，作为 Tauri externalBin（design.md 7.1）。
//
// 流程：缓存/下载 node-v<版本>-win-x64.zip（先 npmmirror，失败回退 nodejs.org）→
// 用同源 SHASUMS256.txt 校验 zip 的 sha256 → 只解出 node.exe →
// 写到 binaries/node-x86_64-pc-windows-msvc.exe，并在旁边记录 .sha256。
// 目标文件已存在且 sha256 与记录一致时直接跳过。
//
// 用法：node scripts/fetch-node.mjs

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const NODE_VERSION = "24.21.0";
const MIRRORS = ["https://npmmirror.com/mirrors/node", "https://nodejs.org/dist"];
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
const entryName = `node-v${NODE_VERSION}-win-x64/node.exe`;
const cacheDir = resolve(repoRoot, "tmp", "node-cache");
const cachedZip = resolve(cacheDir, zipName);
const outFile = resolve(repoRoot, "binaries", `node-${TARGET_TRIPLE}.exe`);
const recordFile = `${outFile}.sha256`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 从 SHASUMS256.txt 文本中取出 zip 的期望 sha256。 */
function expectedHash(shasums) {
  for (const line of shasums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === zipName) return hash.toLowerCase();
  }
  throw new Error(`SHASUMS256.txt 中没有 ${zipName}`);
}

/** 依次尝试各镜像：取 SHASUMS256.txt，复用校验通过的缓存 zip，否则同源下载并校验。 */
async function fetchVerifiedZip() {
  const errors = [];
  for (const base of MIRRORS) {
    const dir = `${base}/v${NODE_VERSION}`;
    try {
      const expected = expectedHash((await download(`${dir}/SHASUMS256.txt`)).toString("utf8"));
      if (existsSync(cachedZip)) {
        const cached = readFileSync(cachedZip);
        if (sha256(cached) === expected) {
          console.log(`[fetch-node] 使用缓存 ${cachedZip}`);
          return cached;
        }
      }
      console.log(`[fetch-node] 下载 ${dir}/${zipName}`);
      const zip = await download(`${dir}/${zipName}`);
      const actual = sha256(zip);
      if (actual !== expected) {
        throw new Error(`sha256 不匹配：期望 ${expected}，实际 ${actual}`);
      }
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachedZip, zip);
      console.log(`[fetch-node] sha256 校验通过 ${actual}`);
      return zip;
    } catch (error) {
      console.warn(`[fetch-node] ${base} 失败：${error.message}`);
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error(`所有镜像均失败：\n${errors.join("\n")}`);
}

/** 读 zip 中央目录，解出单个条目（只支持 stored / deflate，Node 官方 zip 即如此）。 */
function extractEntry(zip, name) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 结构无效：找不到中央目录");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const entry = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (entry === name) {
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = zip.subarray(start, start + compressedSize);
      const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
      if (!data) throw new Error(`不支持的压缩方式 ${method}`);
      if (data.length !== size) throw new Error(`${name} 解压大小不符`);
      return data;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 中没有 ${name}`);
}

async function main() {
  if (process.platform !== "win32") {
    console.log(`[fetch-node] 暂不支持 ${process.platform}（目前只打包 Windows x64），跳过`);
    return;
  }
  if (existsSync(outFile) && existsSync(recordFile)) {
    // 记录格式 "<sha256>  <entryName>"，版本号变了也会重新下载
    const [recorded, recordedEntry] = readFileSync(recordFile, "utf8").trim().split(/\s+/);
    if (recordedEntry === entryName && sha256(readFileSync(outFile)) === recorded) {
      console.log(`[fetch-node] 已存在 node v${NODE_VERSION}（sha256 ${recorded}），跳过`);
      return;
    }
  }
  const zip = await fetchVerifiedZip();
  const exe = extractEntry(zip, entryName);
  const hash = sha256(exe);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(`${outFile}.partial`, exe);
  renameSync(`${outFile}.partial`, outFile);
  writeFileSync(recordFile, `${hash}  ${entryName}\n`);
  console.log(`[fetch-node] 已写入 ${outFile}（${(exe.length / 1024 / 1024).toFixed(1)} MB，sha256 ${hash}）`);
}

main().catch((error) => {
  console.error(`[fetch-node] ${error.message}`);
  process.exit(1);
});
