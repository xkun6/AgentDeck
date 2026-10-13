export type ComposerAttachmentKind = "image" | "file" | "directory";
export type ComposerAttachmentSource = "browser" | "path" | "uploaded";
export type ComposerAttachmentStatus = "ready" | "uploading" | "processing" | "done" | "error";

export interface ComposerAttachment {
  id: string;
  source: ComposerAttachmentSource;
  path?: string;
  file?: File;
  name: string;
  kind: ComposerAttachmentKind;
  status: ComposerAttachmentStatus;
  size?: number;
  mimeType?: string;
  previewUrl?: string;
  uploadedPath?: string;
  uploadedName?: string;
  progress?: number;
  error?: string;
}

export interface ComposerSubmitPayload {
  text: string;
  attachments: ComposerAttachment[];
  workspacePath?: string;
}

/** 输入框斜杠命令补全的候选项（name 不带前导 /）。 */
export interface ComposerSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  /** 名称后的小标签（如「AgentDeck」表示由本应用处理） */
  badge?: string;
}

export interface ComposerSubmitControls {
  updateAttachment(id: string, patch: Partial<ComposerAttachment>): void;
}

export class ComposerAttachmentError extends Error {
  attachmentId?: string;

  constructor(message: string, attachmentId?: string) {
    super(message);
    this.name = "ComposerAttachmentError";
    this.attachmentId = attachmentId;
  }
}
