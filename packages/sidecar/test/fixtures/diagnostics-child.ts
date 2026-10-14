// diagnostics.test.ts 的子进程夹具：按 MODE 触发致命错误 / 未处理拒绝 / 正常退出。
import path from "node:path";

import { installProcessDiagnostics } from "../../src/diagnostics.js";
import { createLogger } from "../../src/logger.js";

const logDir = process.env.FIXTURE_LOG_DIR!;
const mode = process.env.FIXTURE_MODE!;
const logger = createLogger({ logDir, stderr: false });
const diagnostics = installProcessDiagnostics({
  logger,
  logFile: path.join(logDir, "sidecar.log"),
  onFatal: (reason, exitCode) => {
    diagnostics.setExitReason(reason);
    logger.close();
    process.exit(exitCode);
  },
});

if (mode === "throw") {
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
