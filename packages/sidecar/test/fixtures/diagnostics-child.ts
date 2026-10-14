// diagnostics.test.ts 的子进程夹具：按 MODE 触发致命错误 / 未处理拒绝 / 正常退出。
import path from "node:path";

import { claimRunningMarker, installProcessDiagnostics, RUNNING_MARKER_FILE } from "../../src/diagnostics.js";
import { createLogger } from "../../src/logger.js";

const logDir = process.env.FIXTURE_LOG_DIR!;
const mode = process.env.FIXTURE_MODE!;
const logger = createLogger({ logDir, stderr: false });
// FIXTURE_MARKER=1：同 main.ts 一样写 / 清理运行标记
const runningMarkerFile = process.env.FIXTURE_MARKER ? path.join(logDir, RUNNING_MARKER_FILE) : undefined;
const diagnostics = installProcessDiagnostics({
  logger,
  logFile: path.join(logDir, "sidecar.log"),
  ...(runningMarkerFile ? { runningMarkerFile } : {}),
  onFatal: (reason, exitCode) => {
    diagnostics.setExitReason(reason);
    logger.close();
    process.exit(exitCode);
  },
});

if (runningMarkerFile) claimRunningMarker(runningMarkerFile, logger);

if (mode === "kill") {
  // 模拟被外部硬杀：不触发 exit 事件，运行标记残留
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);
} else if (mode === "throw") {
  setTimeout(() => {
    throw new Error("夹具致命错误 adi_0123456789abcdef0123");
  }, 20);
} else if (mode === "reject") {
  Promise.reject(new Error("夹具未处理拒绝"));
  setTimeout(() => {
    diagnostics.setExitReason("夹具正常结束");
    process.exit(0);
  }, 100);
} else {
  diagnostics.setExitReason("stdin end");
  process.exit(0);
}
