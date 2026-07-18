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

// #624：把每个附件的 url 强制锚定到本频道的下载端点（由 key 推导），绝不信任客户端传入的 url。
// 否则频道成员可把 url 指向攻击者源；其他成员的客户端渲染时会携带自己的 bearer token 去 fetch 该
// url（见 web AttachmentList useAttachmentBlobUrl / resolveAttachmentDownloadUrl），token 即外泄。
// 下载端点（GET /api/channels/:slug/attachments/:path）按 URL 里的 slug 从 R2 取对象，key 只是引用，
// 所以这里只需保证落库/回传的 url 永远是同源相对路径。key 未按频道前缀（上传端点构造为 `${slug}/…`）
// 时仍强制锚定成同源路径——最坏是个无效链接，绝不外泄。入站落库与出站回传两侧都要过一遍。
export function anchorAttachmentUrls(
  attachments: Attachment[] | undefined,
  slug: string,
): Attachment[] | undefined {
  if (attachments === undefined) return undefined;
  const prefix = `${slug}/`;
  return attachments.map((a) => ({
    ...a,
    url: `/api/channels/${slug}/attachments/${a.key.startsWith(prefix) ? a.key.slice(prefix.length) : a.key}`,
  }));
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
