#!/usr/bin/env node
// Lightweight CDP client for Tauri webview debugging.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 \
//     --remote-allow-origins=*" pnpm tauri:dev
//   node scripts/cdp-eval.mjs '<javascript expression>'
//
// Example:
//   node scripts/cdp-eval.mjs 'window.__hermesDebugMessages'
//   node scripts/cdp-eval.mjs 'document.querySelectorAll("[data-role=assistant]").length'

const port = process.env.CDP_PORT || 9222;
const expr = process.argv.slice(2).join(" ");
if (!expr) {
  console.error("usage: node scripts/cdp-eval.mjs <js-expression>");
  process.exit(2);
}

const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
// Pick the Hermes page — its title contains "Hermes" or the URL points at
// localhost:9545 (dev) / tauri.localhost (prod).
const target =
  pages.find((p) => /hermes/i.test(p.title)) ||
  pages.find((p) => /localhost:9545|tauri\.localhost/.test(p.url ?? "")) ||
  pages.find((p) => p.type === "page");
if (!target) {
  console.error("no debugger target found; pages:", pages);
  process.exit(3);
}
console.error(`[cdp] target: ${target.title} ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

const id = 1;
// Wrap expr in an async IIFE so we can await promises, then JSON-stringify
// the final value. Runtime.evaluate with awaitPromise:true unwraps the
// outer Promise back to a primitive string we can ferry over CDP.
const wrappedExpr = `(async () => { try { const __v = await (async () => (${expr}))(); return JSON.stringify(__v); } catch (e) { return JSON.stringify({ __cdpError: String(e), __cdpStack: (e && e.stack) || null }); } })()`;
ws.send(
  JSON.stringify({
    id,
    method: "Runtime.evaluate",
    params: {
      expression: wrappedExpr,
      returnByValue: true,
      awaitPromise: true,
    },
  }),
);

const reply = await new Promise((resolve) => {
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === id) resolve(msg);
  });
});

ws.close();

if (reply.error) {
  console.error("CDP error:", reply.error);
  process.exit(4);
}
const res = reply.result?.result;
if (res?.subtype === "error") {
  console.error("JS error:", res.description);
  process.exit(5);
}
if (process.env.CDP_RAW) {
  console.error("[cdp] raw result:", JSON.stringify(reply.result, null, 2));
}
if (res === undefined) {
  console.log("(no result)");
} else if (res.value === undefined || res.value === null) {
  // value missing → IIFE returned undefined; JSON.stringify(undefined) === undefined
  console.log("(undefined)");
} else if (typeof res.value === "string") {
  try {
    const parsed = JSON.parse(res.value);
    console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  } catch {
    console.log(res.value);
  }
} else {
  console.log(JSON.stringify(res.value, null, 2));
}
