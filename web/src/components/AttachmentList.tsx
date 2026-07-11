// 消息附件渲染（#176）：图片内联缩略图，其它文件给下载按钮。
// 下载端点要 Bearer 鉴权，<img src>/<a href> 带不了头，所以先 fetch 成 blob 再造 objectURL。
import { useEffect, useState } from "react";
import type { Attachment } from "@agentparty/shared";
import { fetchAttachmentBlob, getToken } from "../lib/api";

function isImage(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageThumb({ att }: { att: Attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    fetchAttachmentBlob(getToken(), att.url)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [att.url]);
  if (failed) return <FileLink att={att} />;
  if (src === null) {
    return <span className="msg-attachment-loading t-mono">{att.filename}…</span>;
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" className="msg-attachment-img" title={att.filename}>
      <img src={src} alt={att.filename} loading="lazy" />
    </a>
  );
}

function FileLink({ att }: { att: Attachment }) {
  const onDownload = async () => {
    try {
      const blob = await fetchAttachmentBlob(getToken(), att.url);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch {
      // 静默失败：下载权限/网络问题在 UI 无 toast 约定下不打断阅读
    }
  };
  return (
    <button
      type="button"
      className="d-btn msg-attachment-file t-mono"
      onClick={() => void onDownload()}
      title={`${att.filename} · ${formatSize(att.size)} · download`}
    >
      <span aria-hidden="true">⬇</span>
      <span className="msg-attachment-fname">{att.filename}</span>
      <span className="msg-attachment-size">{formatSize(att.size)}</span>
    </button>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((att) => (
        <div key={att.key} className="msg-attachment">
          {isImage(att.content_type) ? <ImageThumb att={att} /> : <FileLink att={att} />}
        </div>
      ))}
    </div>
  );
}
