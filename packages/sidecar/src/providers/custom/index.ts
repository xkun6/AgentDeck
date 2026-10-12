// 自定义 provider / 三方中转（design.md 4.7）：providers.json 读写、registry 重建、provider.test。
import type { ProviderInfo, ProviderProfile, ProviderTestResult } from "@agentdeck/protocol";

import { AgentRpcError } from "../../agent/errors.js";
import type { Logger } from "../../logger.js";
import type { ProviderRegistry } from "../registry.js";
import { createCustomProviderClient, type CustomClientDeps } from "./custom-client.js";
import { reservedProfileIds } from "./schema.js";
import { loadProviderProfiles, providersConfigPath, saveProviderProfiles } from "./store.js";
import { testProviderProfile, type ProviderTestDeps } from "./test-connection.js";

export { createCustomClaudeLaunch, createCustomProviderClient, CustomProviderClient } from "./custom-client.js";
export {
  buildClaudeLaunchOverride,
  buildCodexLaunchOverride,
  codexModelProviderKey,
  deepMergeSettings,
  deriveClaudeEnv,
  deriveCodexEnv,
  mergeClaudeSettings,
  normalizeOpenAiBaseUrl,
  resolveDisallowedTools,
} from "./launch.js";
export { addSecrets, collectSecrets, createRedactingLogger, redactText } from "./redact.js";
export {
  createProviderProfilesSchema,
  customProviderId,
  isAbsoluteSettingsPath,
  providerProfileSchema,
  reservedProfileIds,
  toProviderProfile,
} from "./schema.js";
export { readClaudeSettingsFile } from "./settings-file.js";
export {
  loadProviderProfiles,
  PROVIDERS_CONFIG_FILE,
  providersConfigPath,
  saveProviderProfiles,
} from "./store.js";
export { buildProviderTestRequest, testProviderProfile } from "./test-connection.js";

export interface CustomProviderServiceOptions {
  registry: Pick<ProviderRegistry, "builtinIds" | "replaceCustomClients" | "listProviderInfo">;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** AGENTDECK_DATA_DIR；未设置时 get 返回空、set 返回 NOT_SUPPORTED */
  dataDir?: string;
  /** 测试注入 */
  clientDeps?: Partial<Pick<CustomClientDeps, "findExecutable" | "createInner">>;
  testDeps?: ProviderTestDeps;
}

/** provider.config.get / set / test 的实现，并负责把 profile 同步进 registry */
export class CustomProviderService {
  private profiles: ProviderProfile[] = [];
  /** 串行化 set，避免两次写盘 / 重建交错 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CustomProviderServiceOptions) {}

  get path(): string | null {
    return this.options.dataDir ? providersConfigPath(this.options.dataDir) : null;
  }

  /** 与内置 provider 冲突的 profile id（provider.config.set 校验用） */
  reservedIds(): Set<string> {
    return reservedProfileIds(this.options.registry.builtinIds());
  }

  /** 启动时读取 providers.json 并注册自定义 provider（失败只记日志） */
  async load(): Promise<void> {
    const file = this.path;
    if (!file) {
      return;
    }
    this.profiles = await loadProviderProfiles(file, this.options.logger, this.reservedIds());
    this.rebuild();
  }

  getConfig(): { providers: ProviderProfile[]; path: string | null } {
    return { providers: structuredClone(this.profiles), path: this.path };
  }

  /** 整表替换：写盘 → 重建自定义 provider → 返回最新 provider.list（入参须已通过整表校验） */
  setConfig(profiles: readonly ProviderProfile[]): Promise<ProviderInfo[]> {
    const run = this.queue.then(async () => {
      const file = this.path;
      if (!file) {
        throw new AgentRpcError(
          "NOT_SUPPORTED",
          "未设置数据目录（AGENTDECK_DATA_DIR），无法保存自定义 provider",
        );
      }
      const next = structuredClone([...profiles]);
      await saveProviderProfiles(file, next);
      this.profiles = next;
      this.rebuild();
      return this.options.registry.listProviderInfo();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  test(profile: ProviderProfile): Promise<ProviderTestResult> {
    return testProviderProfile(profile, {
      ...(this.options.clientDeps?.findExecutable
        ? { findExecutable: this.options.clientDeps.findExecutable }
        : {}),
      ...this.options.testDeps,
    });
  }

  private rebuild(): void {
    const { logger, env, clientDeps } = this.options;
    const clients = this.profiles
      .filter((profile) => profile.enabled !== false)
      .map((profile) => createCustomProviderClient(profile, { logger, env, ...clientDeps }));
    this.options.registry.replaceCustomClients(clients);
    // 只打印 id，不打印 apiKey / env 的值
    logger.info(
      "自定义 provider：共 %d 个，已启用 %s",
      this.profiles.length,
      clients.map((client) => client.provider).join(",") || "（无）",
    );
  }
}
