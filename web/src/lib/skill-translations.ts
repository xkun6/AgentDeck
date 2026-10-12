/**
 * 内置 Skill 的中文翻译表。
 *
 * 后端 `/api/skills` 返回的 name / description 是上游英文。这里在 UI 层
 * 叠一层中文展示，方便中文用户快速理解。键是上游 `name` 字段，未命中
 * 时回退到原文。
 *
 * 翻译来自 SKILL.md 的 description 字段，做了二次润色 — 不是机翻直出。
 * 类目翻译在 `categoryTranslations` 里。
 */

export interface SkillTranslation {
  /** 中文展示名 */
  displayName: string;
  /** 中文描述。比 SKILL.md 的英文 description 更可读。 */
  description: string;
}

export const categoryTranslations: Record<string, string> = {
  apple: "苹果生态",
  "autonomous-ai-agents": "自治 Agent",
  creative: "创意制作",
  "data-science": "数据科学",
  devops: "运维 / DevOps",
  email: "邮件",
  gaming: "游戏",
  github: "GitHub",
  leisure: "生活",
  mcp: "MCP",
  media: "音视频",
  mlops: "ML 运维",
  "note-taking": "笔记",
  productivity: "效率工具",
  "red-teaming": "红队 / 越狱",
  research: "研究 / 资料",
  "smart-home": "智能家居",
  "social-media": "社交媒体",
  "software-development": "软件开发",
  testing: "测试",
  other: "其它",
};

export const skillTranslations: Record<string, SkillTranslation> = {
  // —— apple ——
  "apple-notes": {
    displayName: "Apple Notes 备忘录",
    description: "通过 memo CLI 管理 Apple 备忘录：新建、检索、编辑。",
  },
  "apple-reminders": {
    displayName: "Apple 提醒事项",
    description: "通过 remindctl 管理 Apple 提醒事项：添加、列出、完成。",
  },
  findmy: {
    displayName: "查找我的设备",
    description: "在 macOS 上通过 FindMy.app 追踪 Apple 设备 / AirTag。",
  },
  imessage: {
    displayName: "iMessage 收发",
    description: "在 macOS 上通过 imsg CLI 收发 iMessage / SMS。",
  },

  // —— autonomous-ai-agents ——
  "claude-code": {
    displayName: "Claude Code 代写",
    description: "委托 Claude Code CLI 完成代码任务（功能开发、PR）。",
  },
  codex: {
    displayName: "Codex 代写",
    description: "委托 OpenAI Codex CLI 完成代码任务：功能、重构、PR review、批量修复。需要 codex CLI 和 git 仓库。",
  },
  "hermes-agent": {
    displayName: "Hermes Agent 自身",
    description: "配置、扩展或为 Hermes Agent 贡献代码。",
  },
  opencode: {
    displayName: "OpenCode 代写",
    description: "委托 OpenCode CLI 完成代码任务（功能开发、PR review）。",
  },

  // —— creative ——
  "architecture-diagram": {
    displayName: "架构示意图",
    description: "生成深色主题的 SVG 架构图 / 云图 / 基础设施图（HTML 输出）。",
  },
  "ascii-art": {
    displayName: "ASCII 字符艺术",
    description: "使用 pyfiglet、cowsay、boxes、image-to-ascii 生成字符艺术。",
  },
  "ascii-video": {
    displayName: "ASCII 视频",
    description: "把视频 / 音频转换成彩色 ASCII MP4 / GIF。",
  },
  "baoyu-comic": {
    displayName: "宝玉风格漫画",
    description: "宝玉风格的针织漫画生成。",
  },
  "baoyu-infographic": {
    displayName: "宝玉风格信息图",
    description: "宝玉风格的信息图（infographic）生成。",
  },
  "claude-design": {
    displayName: "Claude 设计稿",
    description: "通过 Claude 生成设计稿与 UI 草图。",
  },
  comfyui: {
    displayName: "ComfyUI 工作流",
    description: "用 ComfyUI 节点工作流跑图像生成。",
  },
  ideation: {
    displayName: "创意发散",
    description: "结构化的创意发散：产品、功能、命名、海报。",
  },
  "design-md": {
    displayName: "Markdown 设计稿",
    description: "把设计稿写成结构化 Markdown，便于交付与版本管理。",
  },
  excalidraw: {
    displayName: "Excalidraw 手绘图",
    description: "生成 Excalidraw 风格的手绘示意图。",
  },
  humanizer: {
    displayName: "AI 文本去机感",
    description: "把 AI 生成的文本改写得更像人写。",
  },
  "manim-video": {
    displayName: "Manim 数学动画",
    description: "用 Manim 生成数学公式 / 教学动画。",
  },
  p5js: {
    displayName: "p5.js 创意编程",
    description: "用 p5.js 生成创意代码（视觉、动画、互动）。",
  },
  "pixel-art": {
    displayName: "像素画",
    description: "生成像素艺术风格的图片。",
  },
  "popular-web-designs": {
    displayName: "流行网页设计",
    description: "参考主流网站风格生成网页设计稿。",
  },
  pretext: {
    displayName: "PreText 学术排版",
    description: "用 PreText 排版数学 / 学术文档。",
  },
  sketch: {
    displayName: "Sketch 草图",
    description: "生成 Sketch 风格的设计草图。",
  },
  "songwriting-and-ai-music": {
    displayName: "AI 词曲创作",
    description: "AI 词曲生成、配器、demo 制作。",
  },
  "touchdesigner-mcp": {
    displayName: "TouchDesigner",
    description: "通过 MCP 控制 TouchDesigner 实时视觉。",
  },

  // —— data-science ——
  "jupyter-live-kernel": {
    displayName: "Jupyter 实时内核",
    description: "通过 hamelnb 的实时 Jupyter 内核迭代式跑 Python。",
  },

  // —— devops ——
  "kanban-orchestrator": {
    displayName: "看板调度器",
    description: "拆解任务 + 角色分工的调度 playbook，给 orchestrator-style 项目用。",
  },
  "kanban-worker": {
    displayName: "看板工作者",
    description: "Hermes Kanban worker 的常见坑、示例与边界场景。",
  },
  "webhook-subscriptions": {
    displayName: "Webhook 订阅",
    description: "为外部系统配置 / 调试 webhook 订阅。",
  },

  // —— email ——
  himalaya: {
    displayName: "Himalaya 邮件",
    description: "用 Himalaya CLI 在终端收发 IMAP / SMTP 邮件。",
  },

  // —— gaming ——
  "minecraft-modpack-server": {
    displayName: "Minecraft 模组服务器",
    description: "搭建模组化 Minecraft 服务器（CurseForge、Modrinth）。",
  },
  "pokemon-player": {
    displayName: "宝可梦自动游玩",
    description: "通过无头模拟器 + 内存读取自动游玩宝可梦。",
  },

  // —— github ——
  "codebase-inspection": {
    displayName: "代码库审查",
    description: "用 pygount 检查代码库：行数、语言占比、复杂度。",
  },
  "github-auth": {
    displayName: "GitHub 鉴权",
    description: "GitHub 鉴权配置：HTTPS token、SSH key、gh CLI 登录。",
  },
  "github-code-review": {
    displayName: "GitHub Code Review",
    description: "在 GitHub PR 上做代码 review 的标准流程与建议。",
  },
  "github-issues": {
    displayName: "GitHub Issue 管理",
    description: "Issue 创建、分类、检索、批量操作。",
  },
  "github-pr-workflow": {
    displayName: "GitHub PR 流程",
    description: "PR 工作流：创建、review、合并、cherry-pick。",
  },
  "github-repo-management": {
    displayName: "GitHub 仓库管理",
    description: "仓库设置、分支保护、协作者管理、release 发布。",
  },

  // —— leisure ——
  "find-nearby": {
    displayName: "附近的店",
    description: "用 OpenStreetMap 找附近的餐厅 / 咖啡厅 / 酒吧 / 药店。支持坐标 / 地址输入。",
  },

  // —— mcp ——
  mcporter: {
    displayName: "mcporter CLI",
    description: "用 mcporter CLI 列举、配置、鉴权、直接调用 MCP server / tool（HTTP 或 stdio）。",
  },
  "native-mcp": {
    displayName: "原生 MCP 客户端",
    description: "MCP 客户端：连接 server、注册 tool（stdio / HTTP）。",
  },

  // —— media ——
  "gif-search": {
    displayName: "GIF 搜索",
    description: "通过 curl + jq 在 Tenor 上搜索 / 下载 GIF。",
  },
  heartmula: {
    displayName: "HeartMuLa 歌曲生成",
    description: "类 Suno 的歌词 + 标签到歌曲生成。",
  },
  songsee: {
    displayName: "音频频谱分析",
    description: "通过 CLI 提取音频频谱与特征：mel、chroma、MFCC。",
  },
  spotify: {
    displayName: "Spotify",
    description: "Spotify 控制：播放、搜索、队列、歌单与设备管理。",
  },
  "youtube-content": {
    displayName: "YouTube 内容提取",
    description: "把 YouTube 字幕转成摘要、推文串或博客文章。",
  },

  // —— mlops ——
  "modal-serverless-gpu": {
    displayName: "Modal 无服务器 GPU",
    description: "无服务器 GPU 平台，按需运行 ML workload，无需自管 GPU 集群。",
  },
  "evaluating-llms-harness": {
    displayName: "LLM 评测套件",
    description: "用 lm-eval-harness 跑 LLM benchmark（MMLU、GSM8K 等）。",
  },
  "weights-and-biases": {
    displayName: "Weights & Biases",
    description: "W&B 实验跟踪：log 指标、artifact、sweep。",
  },
  "huggingface-hub": {
    displayName: "Hugging Face Hub",
    description: "拉取 / 上传 HF 模型与数据集。",
  },
  "gguf-quantization": {
    displayName: "GGUF 量化",
    description: "把模型量化成 GGUF 格式以适配 llama.cpp。",
  },
  guidance: {
    displayName: "Guidance 受控生成",
    description: "用 Guidance 库做受控的 LLM 生成。",
  },
  "llama-cpp": {
    displayName: "llama.cpp",
    description: "用 llama.cpp 跑量化后的本地 LLM。",
  },
  obliteratus: {
    displayName: "Obliteratus 拒答消除",
    description: "去除 LLM 的拒答行为（abliteration）。",
  },
  outlines: {
    displayName: "Outlines 结构化生成",
    description: "用 Outlines 让 LLM 输出严格结构化（JSON / regex）。",
  },
  "serving-llms-vllm": {
    displayName: "vLLM 推理服务",
    description: "用 vLLM 高吞吐推理 LLM。",
  },
  "audiocraft-audio-generation": {
    displayName: "Audiocraft 音频生成",
    description: "Meta Audiocraft：MusicGen / AudioGen 音频生成。",
  },
  clip: {
    displayName: "CLIP 图文嵌入",
    description: "OpenAI CLIP：图文对比学习 / 嵌入。",
  },
  "segment-anything-model": {
    displayName: "Segment Anything",
    description: "Meta SAM：万物分割。",
  },
  "stable-diffusion-image-generation": {
    displayName: "Stable Diffusion 出图",
    description: "用 Stable Diffusion 生成图像。",
  },
  whisper: {
    displayName: "Whisper 语音识别",
    description: "OpenAI Whisper：多语种语音转写。",
  },
  dspy: {
    displayName: "DSPy 提示工程",
    description: "用 DSPy 做声明式 LLM 提示与流水线。",
  },
  axolotl: {
    displayName: "Axolotl 微调",
    description: "用 Axolotl 框架微调 LLM。",
  },
  "grpo-rl-training": {
    displayName: "GRPO 强化学习",
    description: "GRPO 算法做 LLM 的 RL 训练。",
  },
  "peft-fine-tuning": {
    displayName: "PEFT 参数高效微调",
    description: "用 PEFT（LoRA / QLoRA 等）做参数高效微调。",
  },
  "pytorch-fsdp": {
    displayName: "PyTorch FSDP 分布式",
    description: "用 PyTorch FSDP 做大模型分布式训练。",
  },
  "fine-tuning-with-trl": {
    displayName: "TRL 微调",
    description: "用 Hugging Face TRL（SFT / DPO / RLHF）做微调。",
  },
  unsloth: {
    displayName: "Unsloth 极速微调",
    description: "用 Unsloth 显著加速 LoRA 微调。",
  },

  // —— note-taking ——
  obsidian: {
    displayName: "Obsidian 笔记",
    description: "读取、检索、新建 Obsidian Vault 中的笔记。",
  },

  // —— productivity ——
  airtable: {
    displayName: "Airtable",
    description: "通过 curl 调 Airtable REST API：记录 CRUD、过滤、upsert。",
  },
  "google-workspace": {
    displayName: "Google Workspace",
    description: "通过 gws CLI 或 Python 调用 Gmail、Calendar、Drive、Docs、Sheets。",
  },
  linear: {
    displayName: "Linear 工单",
    description: "Linear 工单管理：拉取、创建、状态变更、批量分流。",
  },
  maps: {
    displayName: "地图",
    description: "地图查询、路径规划、地理编码。",
  },
  "nano-pdf": {
    displayName: "Nano PDF",
    description: "PDF 处理：合并、拆分、提取文本、加水印。",
  },
  notion: {
    displayName: "Notion",
    description: "Notion 页面 / 数据库读写。",
  },
  "ocr-and-documents": {
    displayName: "OCR 与文档",
    description: "OCR 识别和文档处理。",
  },
  powerpoint: {
    displayName: "PowerPoint",
    description: "生成 / 编辑 PowerPoint 演示文稿。",
  },

  // —— red-teaming ——
  godmode: {
    displayName: "GodMode 越狱",
    description: "LLM 越狱：Parseltongue、GODMODE、ULTRAPLINIAN 等技术。",
  },

  // —— research ——
  arxiv: {
    displayName: "arXiv 论文检索",
    description: "在 arXiv 上按关键词、作者、分类或论文编号检索学术论文。",
  },
  blogwatcher: {
    displayName: "博客 / RSS 监控",
    description: "通过 blogwatcher-cli 监控博客、RSS / Atom 订阅。",
  },
  "llm-wiki": {
    displayName: "LLM 维基",
    description: "查询 LLM 相关知识库。",
  },
  polymarket: {
    displayName: "Polymarket 预测市场",
    description: "Polymarket 预测市场：查询赔率、市场动态。",
  },
  "research-paper-writing": {
    displayName: "学术论文写作",
    description: "学术论文写作流程：选题、综述、实验、写作、投稿。",
  },

  // —— smart-home ——
  openhue: {
    displayName: "Philips Hue 灯",
    description: "通过 OpenHue CLI 控制飞利浦 Hue 灯：场景、房间、亮度。",
  },

  // —— social-media ——
  xitter: {
    displayName: "X / Twitter (xitter)",
    description: "通过 x-cli 终端客户端使用官方 X API：发推、检索、转发等。",
  },
  xurl: {
    displayName: "X / Twitter (xurl)",
    description: "通过 xurl CLI 操作 X / Twitter：发推、检索、私信、媒体、v2 API。",
  },

  // —— software-development ——
  "architecture-review": {
    displayName: "架构梳理",
    description: "梳理项目架构：模块布局、数据流、技术栈与关键抽象。",
  },
  "debugging-hermes-tui-commands": {
    displayName: "Hermes TUI 调试",
    description: "调试 Hermes TUI 斜杠命令：Python、gateway、Ink UI。",
  },
  "hermes-agent-skill-authoring": {
    displayName: "Hermes Skill 编写指南",
    description: "为 Hermes Agent 编写新 Skill 的格式与最佳实践。",
  },
  "node-inspect-debugger": {
    displayName: "Node 调试器",
    description: "用 node --inspect 调试 Node.js 程序。",
  },
  plan: {
    displayName: "规划",
    description: "在动手前做结构化的实施规划。",
  },
  "python-debugpy": {
    displayName: "Python 调试器",
    description: "用 debugpy 调试 Python 程序。",
  },
  "requesting-code-review": {
    displayName: "请求代码 review",
    description: "怎么准备 / 发起一次有效的代码 review 请求。",
  },
  spike: {
    displayName: "Spike 探针",
    description: "用最小代价的 spike 验证可行性 / 收集信息。",
  },
  "subagent-driven-development": {
    displayName: "Subagent 驱动开发",
    description: "把任务拆给多个 subagent 并行推进。",
  },
  "systematic-debugging": {
    displayName: "系统化调试",
    description: "结构化的调试流程：复现、二分、假设、验证。",
  },
  "test-driven-development": {
    displayName: "测试驱动开发",
    description: "TDD：先写失败的测试，再实现，最后重构。",
  },
  "writing-plans": {
    displayName: "写实施计划",
    description: "如何写一份能被多人协作的清晰实施计划。",
  },

  // —— testing ——
  "hello-world-test": {
    displayName: "Hello World 测试",
    description: "演示 Hermes Agent skill 格式与结构的最小测试 skill。",
  },

  // —— other ——
  dogfood: {
    displayName: "产品自测（Dogfood）",
    description: "对 Web 应用做探索性 QA：发现 bug、收集证据、写报告。",
  },
  yuanbao: {
    displayName: "元宝群组",
    description: "元宝群组：@提及成员，查询信息 / 成员列表。",
  },
};

/** 取一个 skill 的中文展示信息，未命中翻译表时回退到上游英文。 */
export function translateSkill(name: string, fallbackDescription: string): SkillTranslation {
  const t = skillTranslations[name];
  if (t) return t;
  return { displayName: name, description: fallbackDescription };
}

/** 取一个类目的中文名，未命中时回退到原 key。 */
export function translateCategory(category: string | null | undefined): string {
  if (!category) return categoryTranslations.other;
  return categoryTranslations[category] ?? category;
}
