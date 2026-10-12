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
