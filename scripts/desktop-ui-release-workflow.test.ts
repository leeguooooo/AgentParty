import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dir, "../.github/workflows/release-desktop-ui.yml");

describe("desktop UI release workflow", () => {
  test("is valid YAML", () => {
    expect(() => Bun.YAML.parse(readFileSync(workflowPath, "utf8"))).not.toThrow();
  });

  test("uses a fixed serialized desktop-ui GitHub Release channel", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: desktop-ui-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("tag_name: desktop-ui");
    expect(workflow).toContain("name: AgentParty Desktop UI");
    expect(workflow).toContain("make_latest: false");
    expect(workflow).toContain("overwrite_files: true");
  });

  test("publishes automatically only after the authoritative main release workflow succeeds", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["release"]');
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toMatch(/^\s+push:\s*$/m);
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
  });

  test("skips superseded release events before checking out their source tree", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, {
        needs?: string;
        if?: string;
        outputs?: Record<string, string>;
        env?: Record<string, string>;
      }>;
    };
    const resolver = parsed.jobs["resolve-source"];
    const build = parsed.jobs["build-sign-publish"];

    expect(resolver.outputs).toEqual({
      source_sha: "${{ steps.source.outputs.source_sha }}",
      current: "${{ steps.source.outputs.current }}",
    });
    expect(workflow).toContain('gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha');
    expect(workflow).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]');
    expect(workflow).toContain('if [ "$SOURCE_SHA" = "$CURRENT_MAIN_SHA" ]');
    expect(workflow).toContain('echo "current=false" >> "$GITHUB_OUTPUT"');
    expect(build.needs).toBe("resolve-source");
    expect(build.if).toBe("needs.resolve-source.outputs.current == 'true'");
    expect(build.env?.SOURCE_SHA).toBe("${{ needs.resolve-source.outputs.source_sha }}");
  });

  test("checks out and publishes the exact successful workflow SHA while preserving manual dispatch", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.event.workflow_run.head_sha || github.sha");
    expect(workflow).toContain("ref: ${{ env.SOURCE_SHA }}");
    expect(workflow).toContain('--build-id "$SOURCE_SHA"');
    expect(workflow).not.toContain('--build-id "$GITHUB_SHA"');
    expect(workflow).toContain('UI_VERSION="0.0.${GITHUB_RUN_NUMBER}"');
    expect(workflow).toContain('PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(workflow).not.toContain("git show -s --format=%cI");
    expect(workflow).toContain('UI_ABI="${INPUT_UI_ABI:-1}"');
    expect(workflow).toContain('MIN_SHELL_VERSION="${INPUT_MIN_SHELL_VERSION:-0.2.94}"');
    expect(workflow).toMatch(/min_shell_version:[\s\S]*?default: "0\.2\.94"/);
  });

  test("builds production web assets and creates deterministic versioned artifacts", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("VITE_API_BASE=https://agentparty.leeguoo.com bunx vite build");
    expect(workflow).toContain('ASSET="agentparty-desktop-ui-v${UI_VERSION}.tar.gz"');
    expect(workflow).toContain("bun scripts/desktop-ui-bundle.ts");
    expect(workflow).toContain("--source web/dist");
    expect(workflow).toContain("bun scripts/desktop-ui-manifest.ts");
    expect(workflow).toContain('--build-id "$SOURCE_SHA"');
    expect(workflow).toContain('--published-at "$PUBLISHED_AT"');
  });

  test("skips automatic publication when deterministic UI content is unchanged", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("id: publication");
    expect(workflow).toContain("bun scripts/desktop-ui-publication.ts");
    expect(workflow).toContain("gh release download desktop-ui");
    expect(workflow).toContain(".plugins.updater.pubkey");
    expect(workflow).toContain('--public-key "$UPDATER_PUBLIC_KEY"');
    expect(workflow).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]');
    expect(workflow).toContain('echo "publish=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain('echo "publish=$publish" >> "$GITHUB_OUTPUT"');
    for (const step of [
      "sign Desktop UI archive",
      "generate Desktop UI manifest",
      "sign Desktop UI manifest",
      "finalize signed Desktop UI manifest envelope",
      "prune desktop-ui release assets",
      "publish fixed desktop-ui release channel",
    ]) {
      const start = workflow.indexOf(`- name: ${step}`);
      const end = workflow.indexOf("\n      - name:", start + 1);
      const block = workflow.slice(start, end === -1 ? undefined : end);
      expect(start).toBeGreaterThan(-1);
      expect(block).toContain("if: steps.publication.outputs.publish == 'true'");
    }
  });

  test("requires the Tauri v2 key and signs the archive before manifest generation", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_V2 }}");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_V2 }}");
    expect(workflow).toMatch(/name: sign Desktop UI archive[\s\S]*?working-directory: desktop/);
    expect(workflow).toContain('bunx tauri signer sign "../dist/$ASSET"');
    expect(workflow.indexOf("sign Desktop UI archive")).toBeLessThan(workflow.indexOf("generate Desktop UI manifest"));
    expect(workflow).toMatch(/name: sign Desktop UI manifest[\s\S]*?working-directory: desktop/);
    expect(workflow).toContain('bunx tauri signer sign "../dist/desktop-ui-manifest-payload.json"');
    expect(workflow).toContain("--payload dist/desktop-ui-manifest-payload.json");
    expect(workflow).toContain("--signature dist/desktop-ui-manifest-payload.json.sig");
  });

  test("prunes old versioned assets below the GitHub 1000-asset ceiling before uploading (#974)", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, {
        steps: { name?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string }[];
      }>;
    };
    const steps = parsed.jobs["build-sign-publish"].steps;
    const names = steps.map((step) => step.name);
    const pruneIndex = names.indexOf("prune desktop-ui release assets");
    const publishIndex = names.indexOf("publish fixed desktop-ui release channel");
    const finalizeIndex = names.indexOf("finalize signed Desktop UI manifest envelope");
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    // Pruning must run after the manifest is final and strictly before the upload;
    // otherwise the upload itself is what trips "file_count limited to 1000 assets".
    expect(pruneIndex).toBeGreaterThan(finalizeIndex);
    expect(pruneIndex).toBe(publishIndex - 1);
    expect(steps[publishIndex].uses).toStartWith("softprops/action-gh-release@");

    const prune = steps[pruneIndex];
    expect(prune.if).toBe("steps.publication.outputs.publish == 'true'");
    expect(prune.if).toBe(steps[publishIndex].if);
    expect(prune.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(prune.env?.DESKTOP_UI_KEEP_VERSIONS).toBe("60");
    expect(prune.run).toContain("set -euo pipefail");
    expect(prune.run).toContain("bun scripts/desktop-ui-prune-assets.ts");
    expect(prune.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(prune.run).toContain('--keep "$DESKTOP_UI_KEEP_VERSIONS"');
    expect(prune.run).toContain('--incoming "$UI_VERSION"');
    expect(prune.run).not.toContain("--dry-run");

    // The current manifest is protected by the script itself, never by workflow arguments.
    const script = readFileSync(resolve(import.meta.dir, "desktop-ui-prune-assets.ts"), "utf8");
    expect(script).toContain('export const CURRENT_MANIFEST = "desktop-ui.json"');
    expect(script).toContain("export const DEFAULT_KEEP = 60");
    expect(script).toContain("if (name === CURRENT_MANIFEST) return null;");
    expect(script).toContain("/repos/${repo}/releases/assets/${asset.id}");
  });

  test("publishes versioned assets plus the stable manifest without touching the normal release", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    expect(workflow).toContain('cp "dist/$VERSIONED_MANIFEST" dist/desktop-ui.json');
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz.sha256");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.tar.gz.sig");
    expect(workflow).toContain("dist/agentparty-desktop-ui-v*.json");
    expect(workflow).toContain("dist/desktop-ui.json");
    expect(workflow).not.toContain("tag_name: ${{ github.ref_name }}");
  });
});
