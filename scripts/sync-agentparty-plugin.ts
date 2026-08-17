import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cliPackagePath = resolve(root, "cli/package.json");
const canonicalSkillPath = resolve(root, "skills/agentparty/SKILL.md");
const bundledSkillPath = resolve(root, "plugins/agentparty/skills/agentparty/SKILL.md");
const manifestPaths = [
  resolve(root, "plugins/agentparty/.claude-plugin/plugin.json"),
  resolve(root, "plugins/agentparty/.codex-plugin/plugin.json"),
] as const;

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function formattedJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function expectedAgentPartyPluginVersion(): string {
  const version = readJson(cliPackagePath).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("cli/package.json has no version");
  }
  return version;
}

export function agentPartyPluginDrift(): string[] {
  const expectedVersion = expectedAgentPartyPluginVersion();
  const drift: string[] = [];

  for (const path of manifestPaths) {
    const version = readJson(path).version;
    if (version !== expectedVersion) {
      drift.push(`${path}: version ${String(version)} != ${expectedVersion}`);
    }
  }

  const canonicalSkill = readFileSync(canonicalSkillPath, "utf8");
  let bundledSkill = "";
  try {
    bundledSkill = readFileSync(bundledSkillPath, "utf8");
  } catch {
    drift.push(`${bundledSkillPath}: missing generated skill mirror`);
  }
  if (bundledSkill && bundledSkill !== canonicalSkill) {
    drift.push(`${bundledSkillPath}: differs from ${canonicalSkillPath}`);
  }

  return drift;
}

export function writeAgentPartyPluginMirror(): void {
  const version = expectedAgentPartyPluginVersion();
  for (const path of manifestPaths) {
    const manifest = readJson(path);
    manifest.version = version;
    writeFileSync(path, formattedJson(manifest));
  }

  mkdirSync(dirname(bundledSkillPath), { recursive: true });
  writeFileSync(bundledSkillPath, readFileSync(canonicalSkillPath));
}

export function runAgentPartyPluginSync(args: string[]): number {
  const write = args.includes("--write");
  const unknown = args.filter((arg) => arg !== "--write" && arg !== "--check");
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown[0]}`);
    return 64;
  }

  if (write) {
    writeAgentPartyPluginMirror();
  }

  const drift = agentPartyPluginDrift();
  if (drift.length > 0) {
    console.error(drift.join("\n"));
    console.error("Run: bun scripts/sync-agentparty-plugin.ts --write");
    return 1;
  }

  console.log("AgentParty plugin mirror is synchronized.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = runAgentPartyPluginSync(process.argv.slice(2));
}
