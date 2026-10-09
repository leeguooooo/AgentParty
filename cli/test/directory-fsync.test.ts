import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncDirectory, type DirectoryFsyncOps } from "../src/directory-fsync";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, fsync`), { code });
}

function fakeOps(platform: NodeJS.Platform, fsyncError: NodeJS.ErrnoException | null) {
  const calls: string[] = [];
  const ops: DirectoryFsyncOps = {
    platform,
    open: (path) => {
      calls.push(`open ${path}`);
      return 42;
    },
    fsync: () => {
      calls.push("fsync");
      if (fsyncError !== null) throw fsyncError;
    },
    close: () => {
      calls.push("close");
    },
  };
  return { ops, calls };
}

describe("fsyncDirectory (#1128)", () => {
  test("Windows: directory fsync (EPERM there) is skipped, so a runner commit cannot fail on it", () => {
    const { ops, calls } = fakeOps("win32", errno("EPERM"));
    expect(() => fsyncDirectory("C:\\agentparty\\continuations", ops)).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("POSIX: EPERM is still a real failure", () => {
    const { ops, calls } = fakeOps("linux", errno("EPERM"));
    expect(() => fsyncDirectory("/x", ops)).toThrow("EPERM");
    expect(calls).toEqual(["open /x", "fsync", "close"]);
  });

  test("POSIX: an explicit capability gap is tolerated and the descriptor is closed", () => {
    for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
      const { ops, calls } = fakeOps("darwin", errno(code));
      expect(() => fsyncDirectory("/x", ops)).not.toThrow();
      expect(calls).toEqual(["open /x", "fsync", "close"]);
    }
  });

  test("POSIX: storage errors fail the commit", () => {
    for (const code of ["EIO", "ENOSPC", "EACCES"]) {
      const { ops } = fakeOps("linux", errno(code));
      expect(() => fsyncDirectory("/x", ops)).toThrow(code);
    }
  });

  test("real directory on this host", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentparty-dir-fsync-"));
    try {
      expect(() => fsyncDirectory(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
