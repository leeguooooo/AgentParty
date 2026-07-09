import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedToken } from "./helpers";

describe("desktop CORS", () => {
  it("allows Tauri preflight requests for API routes", async () => {
    const res = await SELF.fetch("http://ap.test/api/me", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("adds CORS headers to Tauri API responses", async () => {
    const { token } = await seedToken("human", undefined, { owner: "desktop@example.com" });

    const res = await SELF.fetch("http://ap.test/api/me", {
      headers: {
        origin: "http://tauri.localhost",
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
  });

  it("does not add CORS headers for regular web origins", async () => {
    const { token } = await seedToken("human", undefined, { owner: "web@example.com" });

    const res = await SELF.fetch("http://ap.test/api/me", {
      headers: {
        origin: "https://example.com",
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
