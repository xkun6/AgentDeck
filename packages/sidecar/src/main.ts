/**
 * AgentDeck Node sidecar 入口（design.md 第 3 节启动契约）。
 *
 * 读环境变量 → 起 HTTP+WS 服务 → stdout 输出且只输出一行 ready JSON →
 * 监视 stdin end/close、SIGINT/SIGTERM、父进程存活，任一触发即优雅关闭并 exit 0。
 */
import packageJson from "../package.json" with { type: "json" };
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStore } from "./agent/agent-store.js";
import { createLogger, type Logger } from "./logger.js";
import { BoardService } from "./kanban/board-service.js";
import { BoardStore } from "./kanban/store.js";
import { CustomProviderService } from "./providers/custom/index.js";
import { createProviderRegistry, type ProviderRegistry } from "./providers/registry.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { ScheduleStore } from "./scheduler/store.js";
import { InteropService } from "./server/interop-service.js";
import { McpInteropEndpoint } from "./server/mcp-interop.js";
import { RpcServer } from "./server/rpc-server.js";
import { SettingsStore } from "./settings/sidecar-settings.js";
import { SnapshotService } from "./snapshots/snapshot-service.js";
import { UsageLedger } from "./usage/ledger.js";
import { withTimeout } from "./utils/promise-timeout.js";

const SIDECAR_VERSION: string = packageJson.version;
const PARENT_POLL_INTERVAL_MS = 2_000;
/** Rust 关闭 stdin 后只等 3 秒，这里要在此之前完成清理 */
const SHUTDOWN_TIMEOUT_MS = 2_500;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 300;
const EXIT_CONFIG_ERROR = 2;

interface SidecarEnv {
  token: string;
  port: number;
  dataDir?: string;
  logDir?: string;
  parentPid?: number;
}

function fail(message: string): never {
  process.stderr.write(`[sidecar] ${message}\n`);
  process.exit(EXIT_CONFIG_ERROR);
}

function readEnv(env: NodeJS.ProcessEnv): SidecarEnv {
  const token = env.AGENTDECK_TOKEN?.trim();
  if (!token) {
    fail("缺少环境变量 AGENTDECK_TOKEN");
  }

  const rawPort = env.AGENTDECK_PORT?.trim() || "0";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`AGENTDECK_PORT 非法：${rawPort}`);
  }

  const rawParentPid = env.AGENTDECK_PARENT_PID?.trim();
  let parentPid: number | undefined;
  if (rawParentPid) {
    parentPid = Number(rawParentPid);
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
      fail(`AGENTDECK_PARENT_PID 非法：${rawParentPid}`);
    }
  }

  return {
    token,
    port,
    ...(env.AGENTDECK_DATA_DIR ? { dataDir: env.AGENTDECK_DATA_DIR } : {}),
    ...(env.AGENTDECK_LOG_DIR ? { logDir: env.AGENTDECK_LOG_DIR } : {}),
    ...(parentPid !== undefined ? { parentPid } : {}),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但无权发信号
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** stdout 专留给 ready 行：把 console.log/info/debug 改写到日志，防止 provider 依赖误写 stdout */
function protectStdout(logger: Logger): void {
  console.log = (...args: unknown[]) => logger.info("%s", args.map(String).join(" "));
  console.info = console.log;
  console.debug = (...args: unknown[]) => logger.debug("%s", args.map(String).join(" "));
}

async function main(): Promise<void> {
  const config = readEnv(process.env);
  const logger = createLogger(config.logDir ? { logDir: config.logDir } : {});
  protectStdout(logger);
  logger.info("sidecar %s 启动（pid=%d, node=%s）", SIDECAR_VERSION, process.pid, process.version);

  let registry: ProviderRegistry | null = null;
  let manager: AgentManager | null = null;
  let scheduler: Scheduler | null = null;
  let board: BoardService | null = null;
  let server: RpcServer | null = null;
  let parentTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("开始关闭：%s", reason);
    if (parentTimer) {
      clearInterval(parentTimer);
    }
    try {
      await withTimeout(
        (async () => {
          await scheduler?.stop();
          await board?.stop();
          // manager.shutdown 先落盘、再关闭会话、最后再落盘一次
          await manager?.shutdown();
          await registry?.shutdown();
          await server?.close();
        })(),
        SHUTDOWN_TIMEOUT_MS,
        "关闭超时",
      );
    } catch (error) {
      logger.warn("关闭过程出错：%s", String(error));
      // 超时也要尽量把已排队的持久化数据写完再退出
      await withTimeout(
        manager?.flush() ?? Promise.resolve(),
        SHUTDOWN_FLUSH_TIMEOUT_MS,
        "落盘超时",
      ).catch((flushError: unknown) => logger.warn("退出前落盘失败：%s", String(flushError)));
    }
    logger.info("sidecar 退出（code=%d）", exitCode);
    logger.close();
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (error) => {
    logger.error("未处理的 Promise 拒绝：%s", error instanceof Error ? error.stack : String(error));
  });
  process.on("uncaughtException", (error) => {
    logger.error("未捕获的异常：%s", error.stack ?? String(error));
    void shutdown("uncaughtException", 1);
  });

  // Rust 关闭 stdin 即要求退出；必须让 stdin 处于 flowing 状态才能收到 end
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));
  process.stdin.on("error", (error) => {
    logger.warn("stdin 错误：%s", error.message);
    void shutdown("stdin error");
  });
  process.stdin.on("data", () => undefined);
  process.stdin.resume();

  if (config.parentPid !== undefined) {
    const parentPid = config.parentPid;
    parentTimer = setInterval(() => {
      if (!isProcessAlive(parentPid)) {
        void shutdown(`父进程 ${parentPid} 已退出`);
      }
    }, PARENT_POLL_INTERVAL_MS);
  }

  registry = await createProviderRegistry({
    logger,
    env: process.env,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  });
  // 自定义 provider（providers.json，design.md 4.7）要在恢复历史会话前注册，dormant 会话才能找到对应 client
  const providerConfig = new CustomProviderService({
    registry,
    logger,
    env: process.env,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  });
  try {
    await providerConfig.load();
  } catch (error) {
    logger.error("加载自定义 provider 失败：%s", String(error));
  }
  // 设置了 AGENTDECK_DATA_DIR 才持久化会话（design.md 4.5）；恢复失败只记日志，不影响启动
  const store = config.dataDir ? new AgentStore({ dataDir: config.dataDir, logger }) : undefined;
  // 跨会话用量账本（design.md 4.20）：读取失败只记日志；未设置 AGENTDECK_DATA_DIR 时只在内存累计
  const usage = new UsageLedger({ logger, ...(config.dataDir ? { dataDir: config.dataDir } : {}) });
  try {
    await usage.load();
  } catch (error) {
    logger.error("加载用量账本失败：%s", String(error));
  }
  // sidecar 设置与按回合文件快照（design.md 4.24）：设置读取失败只记日志，沿用默认值
  const settings = new SettingsStore({ logger, ...(config.dataDir ? { dataDir: config.dataDir } : {}) });
  await settings.load();
  const snapshots = new SnapshotService({
    logger,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    settings: () => settings.get().snapshots,
    agentCwd: (agentId) => manager?.listAgents().find((agent) => agent.id === agentId)?.cwd,
    listAgents: () => manager?.listAgents().map((agent) => ({ id: agent.id, cwd: agent.cwd })) ?? [],
    isCwdBusy: (cwd) => manager?.isCwdBusy(cwd) ?? false,
  });
  // 会话互通（design.md 4.26）：每会话 token 与 /mcp 端点；端口在监听后告知
  const interop = new InteropService({ settings: () => settings.get().interop });
  manager = new AgentManager({
    registry,
    logger,
    usage,
    snapshots,
    interop,
    ...(store ? { store } : {}),
  });
  manager.subscribe({ onRemoved: (agentId) => interop.forget(agentId) });
  try {
    await manager.restore();
  } catch (error) {
    logger.error("恢复历史会话失败：%s", String(error));
  }
  // 调度器（design.md 4.25）：定时任务 / 心跳 / 目标循环；启动失败只记日志，不影响 sidecar 启动
  scheduler = new Scheduler({
    manager,
    store: new ScheduleStore({ logger, ...(config.dataDir ? { dataDir: config.dataDir } : {}) }),
    logger,
  });
  try {
    await scheduler.start();
  } catch (error) {
    logger.error("启动调度器失败：%s", String(error));
  }
  // 看板（design.md 4.28）：补判重启前仍在 running 的任务、检查自动派发；启动失败只记日志
  board = new BoardService({
    manager,
    store: new BoardStore({ logger, ...(config.dataDir ? { dataDir: config.dataDir } : {}) }),
    logger,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
  });
  try {
    await board.start();
  } catch (error) {
    logger.error("启动看板服务失败：%s", String(error));
  }
  server = new RpcServer({
    token: config.token,
    version: SIDECAR_VERSION,
    manager,
    registry,
    providerConfig,
    usage,
    settings,
    snapshots,
    scheduler,
    board,
    mcp: new McpInteropEndpoint({
      manager,
      registry,
      interop,
      logger,
      ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    }),
    logger,
  });

  const port = await server.listen(config.port, "127.0.0.1");
  interop.setPort(port);
  if (shuttingDown) {
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ type: "ready", port, version: SIDECAR_VERSION, pid: process.pid })}\n`,
  );
  // 历史用量回填在后台进行（design.md 4.20），不阻塞启动；完成前 usage.summary 带 backfilling: true
  if (store && usage.backfilling) {
    const backfillAgents = manager.listAgents().map((agent) => ({
      id: agent.id,
      provider: agent.provider,
      model: agent.model ?? null,
    }));
    void usage.backfill(backfillAgents, (agentId) => store.streamTimeline(agentId));
  }
  logger.info(
    "已监听 127.0.0.1:%d（epoch=%s, providers=%s）",
    port,
    manager.epoch,
    registry
      .list()
      .map((client) => client.provider)
      .join(","),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[sidecar] 启动失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
