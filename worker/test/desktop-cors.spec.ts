import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedToken } from "./helpers";

describe("desktop CORS", () => {
  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])(
    "allows %s preflight requests for API routes",
    async (origin) => {
      const res = await SELF.fetch("http://ap.test/api/me", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization,content-type",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(res.headers.get("vary")).toContain("Origin");
    },
  );
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

  it("rejects API requests from untrusted origins", async () => {
    const { token } = await seedToken("human", undefined, { owner: "web@example.com" });

    const res = await SELF.fetch("http://ap.test/api/me", {
      headers: {
        origin: "https://example.com",
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects malicious preflights without reflecting their origin", async () => {
    const res = await SELF.fetch("http://ap.test/api/desktop/pairings", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
