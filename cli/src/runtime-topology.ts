import type { RuntimeTopology } from "@agentparty/shared";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { agentpartyHome } from "./config";

const SECRET_FILE = "node-secret";
const SECRET_RE = /^[a-f0-9]{64}$/;
const PROCESS_RUNTIME_ID = randomUUID();

interface RuntimeTopologyDeps {
  home?: string;
  runtimeId?: string;
  secret?: string;
  /** Read-only diagnostics may compare only after a live runtime created the installation secret. */
  createSecret?: boolean;
  git?: (cwd: string, args: string[]) => string | null;
  harnessSession?: RuntimeTopology["harness_session"];
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function normalizedServer(server: string): string {
  try {
    const url = new URL(server);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch {
    return server.trim().replace(/\/+$/, "");
  }
}

function defaultGit(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    const output = String(result.stdout).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

function readSecret(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 128 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = readFileSync(path, "utf8").trim();
    return SECRET_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One random installation secret backs unlinkable per-server node refs. The raw
 * secret never leaves the machine and is deliberately separate from auth tokens.
 */
export function loadOrCreateNodeSecret(home: string = agentpartyHome()): string | null {
  const directory = canonicalPath(home);
  const path = resolve(directory, SECRET_FILE);
  const existing = readSecret(path);
  if (existing !== null) return existing;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const candidate = randomBytes(32).toString("hex");
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${candidate}\n`, "utf8");
    } finally {
      closeSync(fd);
    }
    return candidate;
  } catch {
    // Another process may have won the O_EXCL race. Never overwrite an
    // unreadable or malformed identity file: omit topology instead.
    return readSecret(path);
  }
}

function opaqueRef(prefix: string, secret: string, server: string, value: string): string {
  const digest = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`agentparty-runtime-topology-v1\0${server}\0${prefix}\0${value}`)
    .digest("base64url")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

/**
 * Build topology without exposing hostname, username, repository path, or Git
 * remote. A failure to read local identity state degrades to no topology and
 * never prevents the delivery connection from starting.
 */
export function buildRuntimeTopology(
  server: string,
  cwd: string = process.cwd(),
  deps: RuntimeTopologyDeps = {},
): RuntimeTopology | undefined {
  const home = deps.home ?? agentpartyHome();
  const secret = deps.secret ?? (
    deps.createSecret === false
      ? readSecret(resolve(canonicalPath(home), SECRET_FILE))
      : loadOrCreateNodeSecret(home)
  );
  if (secret === null || !SECRET_RE.test(secret)) return undefined;
  const serverScope = normalizedServer(server);
  if (serverScope === "") return undefined;
  const git = deps.git ?? defaultGit;
  const worktreePath = canonicalPath(git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd);
  const rawCommonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const workspacePath = canonicalPath(rawCommonDir ?? worktreePath);
  const runtimeId = deps.runtimeId ?? PROCESS_RUNTIME_ID;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runtimeId)) return undefined;
  return {
    version: 1,
    node_ref: opaqueRef("node", secret, serverScope, "installation"),
    runtime_ref: opaqueRef("runtime", secret, serverScope, runtimeId),
    workspace_ref: opaqueRef("workspace", secret, serverScope, workspacePath),
    worktree_ref: opaqueRef("worktree", secret, serverScope, worktreePath),
    peer_scope: "local_installation",
    evidence: "client_asserted",
    ...(deps.harnessSession === undefined ? {} : { harness_session: deps.harnessSession }),
  };
}
