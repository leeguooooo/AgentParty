import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, posix, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const usage = "Usage: bun scripts/desktop-ui-bundle.ts --source <web-dist> --output <archive.tar.gz>";

export interface DesktopUiBundleInput {
  source: string;
  output: string;
}

export interface DesktopUiBundleResult {
  archive: string;
  checksum: string;
  sha256: string;
}

interface ArchiveEntry {
  name: string;
  kind: "directory" | "file";
  contents?: Buffer;
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`Tar header value is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length > length) throw new Error(`Tar numeric value is too large: ${value}`);
  writeString(header, offset, length, encoded);
}

function splitTarPath(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  const separators = [...name.matchAll(/\//g)].map((match) => match.index!);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const prefix = name.slice(0, separators[index]);
    const suffix = name.slice(separators[index] + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`Desktop UI path is too long for ustar: ${name}`);
}

function tarHeader(entry: ArchiveEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const path = splitTarPath(entry.name);
  writeString(header, 0, 100, path.name);
  writeOctal(header, 100, 8, entry.kind === "directory" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.contents?.length ?? 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.kind === "directory" ? 0x35 : 0x30;
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, path.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

function collectEntries(source: string): ArchiveEntry[] {
  const sourceStat = statSync(source, { throwIfNoEntry: false });
  if (!sourceStat?.isDirectory()) throw new Error(`Desktop UI source is not a directory: ${source}`);

  const entries: ArchiveEntry[] = [];
  function visit(directory: string): void {
    for (const child of readdirSync(directory).sort()) {
      const absolute = resolve(directory, child);
      const metadata = lstatSync(absolute);
      const relativeName = relative(source, absolute).split(sep).join(posix.sep);
      const archiveName = relativeName;
      if (metadata.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${relativeName}`);
      if (metadata.isDirectory()) {
        entries.push({ name: `${archiveName}/`, kind: "directory" });
        visit(absolute);
      } else if (metadata.isFile()) {
        entries.push({ name: archiveName, kind: "file", contents: readFileSync(absolute) });
      } else {
        throw new Error(`Unsupported Desktop UI entry: ${relativeName}`);
      }
    }
  }
  visit(source);
  if (entries.length === 0) throw new Error("Desktop UI source is empty");
  return entries;
}

function buildTar(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    if (entry.contents) {
      chunks.push(entry.contents);
      const padding = (BLOCK_SIZE - (entry.contents.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function writeAtomically(path: string, contents: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createDesktopUiBundle(input: DesktopUiBundleInput): DesktopUiBundleResult {
  const source = resolve(input.source);
  const output = resolve(input.output);
  if (output === source || output.startsWith(`${source}${sep}`)) {
    throw new Error("Desktop UI archive must be outside the source directory");
  }

  const compressed = gzipSync(buildTar(collectEntries(source)), { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  writeAtomically(output, compressed);
  writeAtomically(`${output}.sha256`, `${sha256}  ${basename(output)}\n`);
  return { archive: output, checksum: `${output}.sha256`, sha256 };
}

function parseArguments(arguments_: string[]): DesktopUiBundleInput {
  if (arguments_.length !== 4) throw new Error(usage);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if ((flag !== "--source" && flag !== "--output") || !value || values.has(flag)) throw new Error(usage);
    values.set(flag, value);
  }
  if (!values.has("--source") || !values.has("--output")) throw new Error(usage);
  return { source: values.get("--source")!, output: values.get("--output")! };
}

if (import.meta.main) {
  try {
    createDesktopUiBundle(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
