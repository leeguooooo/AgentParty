import { closeSync, fsyncSync, openSync } from "node:fs";

/** Filesystem seam so the platform split can be exercised without a Windows box. */
export interface DirectoryFsyncOps {
  platform: NodeJS.Platform;
  open: (path: string) => number;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
}

const defaultOps: DirectoryFsyncOps = {
  platform: process.platform,
  open: (path) => openSync(path, "r"),
  fsync: fsyncSync,
  close: closeSync,
};

/**
 * POSIX filesystems that cannot fsync a directory descriptor say so with one of these codes. Only
 * that explicit capability gap is safe to ignore; ENOSPC/EIO/EACCES/EPERM must still fail a commit.
 */
export function isUnsupportedDirectoryFsync(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS";
}

/**
 * Make a just-renamed directory entry durable.
 *
 * Windows has no directory fsync: FlushFileBuffers on a directory handle fails with EPERM, which
 * made every serve runner commit throw and drop the model's reply (#1128). NTFS journals the
 * rename's metadata itself, so on win32 there is nothing to flush and the call is skipped.
 */
export function fsyncDirectory(path: string, ops: DirectoryFsyncOps = defaultOps): void {
  if (ops.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = ops.open(path);
    ops.fsync(fd);
  } catch (error) {
    if (!isUnsupportedDirectoryFsync(error)) throw error;
  } finally {
    if (fd !== null) ops.close(fd);
  }
}
