// 附件引用校验（#176）——消息与任务（#369）共用。R2 上传由 /api/channels/:slug/attachments
// 完成，这里只校验/序列化随消息或任务带上的**引用**（key/filename/content_type/size/url）。
// 安全相关（key 锚定频道 slug 做跨频道隔离），必须单一实现，禁止在 do.ts / index.ts 各拷一份漂移。
import type { Attachment } from "@agentparty/shared";

export const MAX_ATTACHMENTS = 20;
const ATTACHMENT_KEY_MAX = 1024;
const ATTACHMENT_FILENAME_MAX = 512;
const ATTACHMENT_CONTENT_TYPE_MAX = 256;
const ATTACHMENT_URL_MAX = 2048;

// 入站校验：undefined/null/空数组 → undefined（无附件）；非法结构/超限 → null（调用方回 400）。
export function parseAttachments(raw: unknown): Attachment[] | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_ATTACHMENTS) return null;
  const out: Attachment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const a = item as Record<string, unknown>;
    if (typeof a.key !== "string" || a.key.length === 0 || a.key.length > ATTACHMENT_KEY_MAX) return null;
    if (typeof a.filename !== "string" || a.filename.length === 0 || a.filename.length > ATTACHMENT_FILENAME_MAX) return null;
    if (typeof a.content_type !== "string" || a.content_type.length === 0 || a.content_type.length > ATTACHMENT_CONTENT_TYPE_MAX) return null;
    if (typeof a.size !== "number" || !Number.isInteger(a.size) || a.size < 0) return null;
    if (typeof a.url !== "string" || a.url.length === 0 || a.url.length > ATTACHMENT_URL_MAX) return null;
    out.push({ key: a.key, filename: a.filename, content_type: a.content_type, size: a.size, url: a.url });
  }
  return out;
}

// 出站：库里存的 attachments_json 字符串 → Attachment[]（非法/空 → undefined，序列化时省略字段）。
export function parseStoredAttachments(input: unknown): Attachment[] | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    const parsed = parseAttachments(JSON.parse(input) as unknown);
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

// 单附件字段（任务 solution）与 attachments[] 共用同一套结构校验，但存储为对象而不是单元素数组。
export function parseAttachment(raw: unknown): Attachment | null {
  const parsed = parseAttachments([raw]);
  return parsed === null || parsed === undefined || parsed.length !== 1 ? null : parsed[0]!;
}

export function parseStoredAttachment(input: unknown): Attachment | undefined {
  if (typeof input !== "string" || input === "") return undefined;
  try {
    return parseAttachment(JSON.parse(input) as unknown) ?? undefined;
  } catch {
    return undefined;
  }
}
