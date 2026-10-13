import { describe, expect, it } from "vitest";
import type { ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import {
  buildProviderMenuEntries,
  emptyProviderForm,
  formatSettingsText,
  formToProfile,
  isAbsoluteSettingsPath,
  issuePathToField,
  joinCommandLine,
  mapIssuesToForm,
  mergeFetchedModels,
  parseSettingsText,
  profileHasClaudeSettings,
  profileHost,
  profileToForm,
  readRpcIssues,
  relaySessionState,
  reservedProfileIds,
  setDefaultModel,
  slugifyProfileId,
  splitCommandLine,
  validateProfileId,
  validateProviderForm,
  type ProviderFormState,
} from "./provider-profiles";

describe("id slug 生成与校验", () => {
  it("名称转小写、非字母数字折叠为 -、去首尾 -", () => {
    expect(slugifyProfileId("My Relay")).toBe("my-relay");
    expect(slugifyProfileId("  OpenRouter / Claude 4.5  ")).toBe("openrouter-claude-4-5");
    expect(slugifyProfileId("Café Résumé")).toBe("cafe-resume");
  });

  it("纯中文或空名称回落到 relay；数字开头补前缀；最长 32 位", () => {
    expect(slugifyProfileId("我的中转")).toBe("relay");
    expect(slugifyProfileId("")).toBe("relay");
    expect(slugifyProfileId("88code 中转")).toBe("relay-88code");
    const long = slugifyProfileId("a".repeat(50));
    expect(long).toHaveLength(32);
    expect(validateProfileId(long)).toBeNull();
    // 截断后不以 - 结尾
    expect(slugifyProfileId(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
  });

  it("与已用 / 保留 id 冲突时追加序号", () => {
    const reserved = reservedProfileIds([
      { id: "claude" },
      { id: "codex" },
      { id: "acp:dsh" },
      { id: "custom:mine", custom: true },
    ]);
    expect([...reserved]).toEqual(expect.arrayContaining(["claude", "codex", "acp", "mock", "custom", "dsh"]));
    expect(reserved.has("mine")).toBe(false);
    expect(slugifyProfileId("Claude", reserved)).toBe("claude-2");
    expect(slugifyProfileId("DSH", reserved)).toBe("dsh-2");
    expect(slugifyProfileId("x", new Set(["x", "x-2"]))).toBe("x-3");
    expect(slugifyProfileId("b".repeat(40), new Set(["b".repeat(32)]))).toBe(`${"b".repeat(30)}-2`);
  });

  it("validateProfileId 按 ^[a-z][a-z0-9-]{0,31}$ 校验", () => {
    for (const ok of ["a", "my-relay", "r2", `a${"b".repeat(31)}`]) expect(validateProfileId(ok)).toBeNull();
    expect(validateProfileId("")).toContain("不能为空");
    for (const bad of ["1abc", "-a", "My", "a_b", "a b", `a${"b".repeat(32)}`]) {
      expect(validateProfileId(bad)).toContain("小写字母开头");
    }
  });
});

describe("命令行切分", () => {
  it("按空白切分，连续空白忽略", () => {
    expect(splitCommandLine("  npx -y  @scope/agent --acp ")).toEqual(["npx", "-y", "@scope/agent", "--acp"]);
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("   ")).toEqual([]);
  });

  it("单 / 双引号内保留空格，引号去掉；空引号是空参数", () => {
    expect(splitCommandLine('"C:\\Program Files\\Agent\\agent.exe" --acp')).toEqual([
      "C:\\Program Files\\Agent\\agent.exe",
      "--acp",
    ]);
    expect(splitCommandLine("run --name 'my agent' --x=\"a b\"")).toEqual(["run", "--name", "my agent", "--x=a b"]);
    expect(splitCommandLine('a "" b')).toEqual(["a", "", "b"]);
    expect(splitCommandLine(`say "it's"`)).toEqual(["say", "it's"]);
  });

  it("反斜杠不转义；未闭合引号延续到行尾", () => {
    expect(splitCommandLine("C:\\tools\\agent.exe")).toEqual(["C:\\tools\\agent.exe"]);
    expect(splitCommandLine('cmd "unterminated arg')).toEqual(["cmd", "unterminated arg"]);
  });

  it("joinCommandLine 与 splitCommandLine 往返一致", () => {
    const cases = [
      ["npx", "-y", "@scope/agent"],
      ["C:\\Program Files\\x.exe", "--flag"],
      ["say", 'he said "hi"'],
      ["a", "", "b"],
    ];
    for (const args of cases) expect(splitCommandLine(joinCommandLine(args))).toEqual(args);
    expect(joinCommandLine(["C:\\Program Files\\x.exe", "--acp"])).toBe('"C:\\Program Files\\x.exe" --acp');
  });
});

describe("issues 路径 → 表单字段", () => {
  it("providers.<i>.<field> 只映射当前项", () => {
    expect(issuePathToField("providers.2.baseUrl", 2)).toBe("baseUrl");
    expect(issuePathToField("providers.2.id", 2)).toBe("id");
    expect(issuePathToField("providers.1.id", 2)).toBeNull();
    expect(issuePathToField("providers.1.id", null)).toBeNull();
    expect(issuePathToField("providers", 0)).toBeNull();
    expect(issuePathToField("providers.0", 0)).toBeNull();
  });

  it("provider.test 的 profile.<field> 与嵌套路径", () => {
    expect(issuePathToField("profile.apiKey", null)).toBe("apiKey");
    expect(issuePathToField("profile.models.1.id", null)).toBe("models.1.id");
    expect(issuePathToField("providers.0.models.3.label", 0)).toBe("models.3.label");
    expect(issuePathToField("providers.0.models.3.description", 0)).toBe("models");
    expect(issuePathToField("providers.0.models", 0)).toBe("models");
    expect(issuePathToField("providers.0.command.2", 0)).toBe("command");
    expect(issuePathToField("providers.0.env.BAD KEY", 0)).toBe("env");
    expect(issuePathToField("providers.0.disallowedTools.0", 0)).toBe("disallowedTools");
    expect(issuePathToField("other.x", 0)).toBeNull();
  });

  it("mapIssuesToForm 区分字段错误与其它错误，同字段取第一条", () => {
    const issues = readRpcIssues({
      issues: [
        { path: "providers.1.id", message: "id「claude」与内置 provider 冲突" },
        { path: "providers.1.id", message: "第二条" },
        { path: "providers.0.label", message: "别的项" },
        { path: "", message: "整表错误" },
        { bad: true },
      ],
    });
    expect(issues).toHaveLength(4);
    expect(mapIssuesToForm(issues, 1)).toEqual({
      fields: { id: "id「claude」与内置 provider 冲突" },
      general: ["别的项", "整表错误"],
    });
    expect(readRpcIssues(undefined)).toEqual([]);
    expect(readRpcIssues({ issues: "x" })).toEqual([]);
  });
});

function form(patch: Partial<ProviderFormState> = {}): ProviderFormState {
  return { ...emptyProviderForm("claude"), label: "My Relay", id: "my-relay", ...patch };
}

function model(id: string, label = "", isDefault = false, key = `k-${id}`) {
  return { key, id, label, description: "", isDefault };
}

describe("表单 ↔ ProviderProfile", () => {
  it("空字段省略；claude 带 authMode；enabled 只在停用时写 false", () => {
    expect(formToProfile(form({ description: "  ", baseUrl: " ", apiKey: "" }))).toEqual({
      id: "my-relay",
      extends: "claude",
      label: "My Relay",
      authMode: "auth_token",
    });
    expect(formToProfile(form({ enabled: false })).enabled).toBe(false);
  });

  it("Base URL 去末尾 /，密钥去空白，自定义禁用工具（含空列表）", () => {
    const profile = formToProfile(form({
      baseUrl: " http://127.0.0.1:9/ ",
      apiKey: " fake-key ",
      authMode: "api_key",
      customDisallowedTools: true,
      disallowedToolsText: "WebSearch, WebFetch，Task",
    }));
    expect(profile.baseUrl).toBe("http://127.0.0.1:9");
    expect(profile.apiKey).toBe("fake-key");
    expect(profile.authMode).toBe("api_key");
    expect(profile.disallowedTools).toEqual(["WebSearch", "WebFetch", "Task"]);
    expect(formToProfile(form({ customDisallowedTools: true, disallowedToolsText: "" })).disallowedTools).toEqual([]);
    expect(formToProfile(form({ customDisallowedTools: false, disallowedToolsText: "X" })).disallowedTools).toBeUndefined();
  });

  it("非 claude 不提交 authMode / disallowedTools；ACP 不提交 baseUrl / apiKey", () => {
    const codex = formToProfile(form({ extends: "codex", baseUrl: "https://x.test", customDisallowedTools: true }));
    expect(codex.authMode).toBeUndefined();
    expect(codex.disallowedTools).toBeUndefined();
    expect(codex.baseUrl).toBe("https://x.test");
    const acp = formToProfile(form({ extends: "acp", baseUrl: "https://x.test", apiKey: "k", commandText: 'agent "--a b"' }));
    expect(acp).toEqual({ id: "my-relay", extends: "acp", label: "My Relay", command: ["agent", "--a b"] });
  });

  it("模型：空行丢弃、显示名缺省为 id、默认模型只保留第一个", () => {
    const profile = formToProfile(form({
      models: [model("m1", "", true), model("", ""), model("m2", "Model 2", true), model("m3", " M3 ")],
    }));
    expect(profile.models).toEqual([
      { id: "m1", label: "m1", isDefault: true },
      { id: "m2", label: "Model 2" },
      { id: "m3", label: "M3" },
    ]);
    expect(formToProfile(form({ models: [model("", "")] })).models).toBeUndefined();
  });

  it("环境变量：空行丢弃，值原样保留", () => {
    const profile = formToProfile(form({
      env: [
        { key: "a", name: " FOO ", value: " v " },
        { key: "b", name: "", value: "" },
      ],
    }));
    expect(profile.env).toEqual({ FOO: " v " });
    expect(formToProfile(form({ env: [{ key: "b", name: "", value: "" }] })).env).toBeUndefined();
  });

  it("profileToForm → formToProfile 往返保持不变", () => {
    const profiles: ProviderProfile[] = [
      {
        id: "relay",
        extends: "claude",
        label: "Relay",
        description: "desc",
        enabled: false,
        baseUrl: "https://relay.test",
        apiKey: "fake",
        authMode: "api_key",
        env: { A: "1" },
        command: ["C:\\Program Files\\claude.exe", "--x"],
        models: [{ id: "m1", label: "M1", isDefault: true }, { id: "m2", label: "M2", description: "d" }],
        disallowedTools: [],
      },
      { id: "acp-one", extends: "acp", label: "ACP", command: ["agent", "--acp"] },
      { id: "cx", extends: "codex", label: "Codex 中转", baseUrl: "https://c.test/v1", models: [{ id: "gpt", label: "GPT" }] },
    ];
    for (const profile of profiles) {
      const restored = formToProfile(profileToForm(profile));
      if (profile.extends === "claude" && !profile.authMode) expect(restored).toEqual({ ...profile, authMode: "auth_token" });
      else expect(restored).toEqual(profile);
    }
    const editing = profileToForm(profiles[0]!);
    expect(editing.idTouched).toBe(true);
    expect(editing.enabled).toBe(false);
    expect(editing.customDisallowedTools).toBe(true);
  });

  it("setDefaultModel 单选，再次点击取消", () => {
    const models = [model("a", "", true), model("b"), model("c")];
    const picked = setDefaultModel(models, "k-b");
    expect(picked.map((item) => item.isDefault)).toEqual([false, true, false]);
    expect(setDefaultModel(picked, "k-b").map((item) => item.isDefault)).toEqual([false, false, false]);
  });

  it("mergeFetchedModels 跳过已有 id、丢弃空行", () => {
    const merged = mergeFetchedModels([model("a", "A"), model("", "")], [
      { id: "a", label: "A2" },
      { id: "b", label: "B" },
      { id: "c", label: "" },
    ]);
    expect(merged.map((item) => [item.id, item.label])).toEqual([["a", "A"], ["b", "B"], ["c", "c"]]);
  });

  it("validateProviderForm：名称、id、URL、ACP 命令、Codex 中转模型必填", () => {
    expect(validateProviderForm(form())).toEqual({});
    expect(validateProviderForm(form({ label: " ", id: "Bad" }))).toMatchObject({
      label: "名称不能为空",
      id: expect.stringContaining("小写字母开头"),
    });
    expect(validateProviderForm(form({ baseUrl: "ftp://x" })).baseUrl).toContain("http");
    expect(validateProviderForm(form({ extends: "acp", commandText: "  " })).command).toContain("启动命令");
    expect(validateProviderForm(form({ extends: "codex", baseUrl: "https://x.test" })).models).toContain("必须");
    expect(validateProviderForm(form({ extends: "codex" })).models).toBeUndefined();
    expect(validateProviderForm(form({ models: [model("", "Label")] }))["models.0.id"]).toContain("不能为空");
    expect(validateProviderForm(form({ env: [{ key: "e", name: "1BAD", value: "x" }] })).env).toBeTruthy();
  });

  it("profileHost 只取 host（含端口）", () => {
    expect(profileHost("http://127.0.0.1:8787/api")).toBe("127.0.0.1:8787");
    expect(profileHost("https://relay.example.com")).toBe("relay.example.com");
    expect(profileHost(undefined)).toBe("");
    expect(profileHost("not a url")).toBe("not a url");
  });
});

describe("Agent 菜单分组", () => {
  const providers: ProviderInfo[] = [
    { id: "claude", kind: "claude", label: "Claude Code", available: true },
    { id: "acp:dsh", kind: "acp", label: "DeepSeek Harness", available: false, unavailableReason: "未安装" },
    { id: "custom:relay", kind: "claude", label: "我的中转", available: true, custom: true, extends: "claude" },
    { id: "custom:broken", kind: "codex", label: "坏中转", available: false, unavailableReason: "找不到 codex", custom: true, extends: "codex" },
  ];
  const profiles: ProviderProfile[] = [
    { id: "relay", extends: "claude", label: "我的中转", baseUrl: "http://127.0.0.1:8787" },
    { id: "off", extends: "codex", label: "停用的", enabled: false, baseUrl: "https://off.test/v1" },
    { id: "broken", extends: "codex", label: "坏中转" },
  ];

  it("内置在前、中转在后；中转按配置顺序，停用 / 不可用置灰", () => {
    const entries = buildProviderMenuEntries(providers, profiles);
    expect(entries.map((entry) => [entry.group, entry.value, entry.disabled])).toEqual([
      ["内置", "claude", false],
      ["内置", "acp:dsh", true],
      ["中转", "custom:relay", false],
      ["中转", "custom:off", true],
      ["中转", "custom:broken", true],
    ]);
    expect(entries[1]!.description).toBe("不可用：未安装");
    expect(entries[2]!.description).toBe("基于 Claude Code · 127.0.0.1:8787");
    expect(entries[3]!.description).toBe("已停用 · 基于 Codex · off.test");
    expect(entries[4]!.description).toBe("不可用：找不到 codex · 基于 Codex");
  });

  it("配置未加载时按 provider.list 列出中转", () => {
    const entries = buildProviderMenuEntries(providers, null);
    expect(entries.filter((entry) => entry.group === "中转").map((entry) => entry.value)).toEqual([
      "custom:relay",
      "custom:broken",
    ]);
    expect(entries.find((entry) => entry.value === "custom:relay")!.description).toBe("基于 Claude Code");
    expect(buildProviderMenuEntries(null, null)).toEqual([]);
  });
});

describe("会话所用中转的状态（已删除 / 停用的会话恢复）", () => {
  const profiles: ProviderProfile[] = [
    { id: "on", extends: "claude", label: "On" },
    { id: "off", extends: "codex", label: "Off", enabled: false },
  ];

  it("区分内置、未加载、启用、停用、已删除", () => {
    expect(relaySessionState("claude", profiles)).toBe("builtin");
    expect(relaySessionState(undefined, profiles)).toBe("builtin");
    expect(relaySessionState("custom:on", undefined)).toBe("unknown");
    expect(relaySessionState("custom:on", profiles)).toBe("present");
    expect(relaySessionState("custom:off", profiles)).toBe("disabled");
    expect(relaySessionState("custom:gone", profiles)).toBe("deleted");
    expect(relaySessionState("custom:gone", [])).toBe("deleted");
  });
});

describe("Claude 设置（settings.json）", () => {
  it("parseSettingsText：留空不使用；非法 JSON / 非对象报错；对象通过", () => {
    expect(parseSettingsText("")).toEqual({ kind: "empty" });
    expect(parseSettingsText("  \n ")).toEqual({ kind: "empty" });
    const bad = parseSettingsText("{ env: ");
    expect(bad.kind).toBe("error");
    expect(bad.kind === "error" && bad.message).toMatch(/^不是合法的 JSON/);
    for (const text of ["[1, 2]", "\"text\"", "42", "null"]) {
      expect(parseSettingsText(text)).toEqual({ kind: "error", message: "必须是 JSON 对象（{ … }），不能是数组或其它值" });
    }
    expect(parseSettingsText(' { "env": { "A": "1" } } ')).toEqual({ kind: "ok", value: { env: { A: "1" } } });
  });

  it("formatSettingsText：合法对象按 2 空格缩进，非法返回 null", () => {
    expect(formatSettingsText('{"env":{"A":"1"},"x":[1]}')).toBe('{\n  "env": {\n    "A": "1"\n  },\n  "x": [\n    1\n  ]\n}');
    expect(formatSettingsText("{ bad")).toBeNull();
    expect(formatSettingsText("")).toBeNull();
  });

  it("formToProfile：空值不写入；路径去空白；内联 JSON 解析为对象；非 claude 不提交", () => {
    expect(formToProfile(form({ settingsFile: "  ", settingsText: " " }))).not.toHaveProperty("settingsFile");
    expect(formToProfile(form({ settingsFile: "  ", settingsText: " " }))).not.toHaveProperty("settings");
    expect(
      formToProfile(form({ settingsFile: "  C:\\cfg\\relay.json ", settingsText: '{ "env": { "API_TIMEOUT_MS": "600000" } }' })),
    ).toMatchObject({ settingsFile: "C:\\cfg\\relay.json", settings: { env: { API_TIMEOUT_MS: "600000" } } });
    const codex = formToProfile(form({ extends: "codex", settingsFile: "/x.json", settingsText: "{}" }));
    expect(codex).not.toHaveProperty("settingsFile");
    expect(codex).not.toHaveProperty("settings");
    // 非法 JSON 不写入（保存前由 validateProviderForm 拦下）
    expect(formToProfile(form({ settingsText: "{ bad" }))).not.toHaveProperty("settings");
  });

  it("profileToForm → formToProfile 往返：settings 格式化为多行文本", () => {
    const profile: ProviderProfile = {
      id: "s",
      extends: "claude",
      label: "S",
      authMode: "auth_token",
      settingsFile: "/home/me/relay.json",
      settings: { env: { A: "1" }, permissions: { allow: ["Bash(ls)"] } },
    };
    const state = profileToForm(profile);
    expect(state.settingsFile).toBe("/home/me/relay.json");
    expect(state.settingsText).toBe(JSON.stringify(profile.settings, null, 2));
    expect(formToProfile(state)).toEqual(profile);
  });

  it("validateProviderForm：设置文件须为绝对路径、内联 JSON 须为对象；非 claude 不校验", () => {
    expect(validateProviderForm(form({ settingsFile: "relay.json" })).settingsFile).toBe("设置文件路径必须是绝对路径");
    expect(validateProviderForm(form({ settingsFile: "C:relay.json" })).settingsFile).toBeTruthy();
    expect(validateProviderForm(form({ settingsFile: "C:\\cfg\\relay.json" })).settingsFile).toBeUndefined();
    expect(validateProviderForm(form({ settingsFile: "\\\\server\\share\\relay.json" })).settingsFile).toBeUndefined();
    expect(validateProviderForm(form({ settingsFile: "/etc/relay.json" })).settingsFile).toBeUndefined();
    expect(validateProviderForm(form({ settingsText: "[]" })).settings).toContain("JSON 对象");
    expect(validateProviderForm(form({ settingsText: "{ bad" })).settings).toMatch(/^不是合法的 JSON/);
    expect(validateProviderForm(form({ extends: "codex", settingsFile: "x", settingsText: "{" }))).toEqual({});
  });

  it("isAbsoluteSettingsPath 与 issues 路径映射", () => {
    expect(isAbsoluteSettingsPath("D:/a.json")).toBe(true);
    expect(isAbsoluteSettingsPath("\\a.json")).toBe(false);
    expect(isAbsoluteSettingsPath("./a.json")).toBe(false);
    expect(issuePathToField("providers.0.settingsFile", 0)).toBe("settingsFile");
    expect(issuePathToField("providers.0.settings", 0)).toBe("settings");
    expect(issuePathToField("profile.settings.env", null)).toBe("settings");
  });

  it("profileHasClaudeSettings：只有基于 Claude Code 且配置了文件或内联设置才标记", () => {
    expect(profileHasClaudeSettings({ id: "a", extends: "claude", label: "A" })).toBe(false);
    expect(profileHasClaudeSettings({ id: "a", extends: "claude", label: "A", settingsFile: "/a.json" })).toBe(true);
    expect(profileHasClaudeSettings({ id: "a", extends: "claude", label: "A", settings: {} })).toBe(true);
    expect(profileHasClaudeSettings({ id: "a", extends: "codex", label: "A", settings: {} })).toBe(false);
  });
});
