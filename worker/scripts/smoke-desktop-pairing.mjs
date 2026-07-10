import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function challenge(verifier) {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function desktopPairingSmokePayload() {
  const verifier = base64url(randomBytes(32));
  const deviceSecret = base64url(randomBytes(32));
  return {
    code_challenge_method: "S256",
    code_challenge: challenge(verifier),
    device_secret_challenge: challenge(deviceSecret),
    device: {
      name: "AgentParty deploy smoke",
      platform: process.platform,
      app_version: process.env.AGENTPARTY_RELEASE_VERSION ?? "deploy-smoke",
    },
  };
}

export async function smokeDesktopPairing(baseInput, fetcher = fetch) {
  const base = new URL(baseInput);
  const endpoint = new URL("/api/desktop/pairings", base);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(desktopPairingSmokePayload()),
    redirect: "error",
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`desktop pairing smoke failed (${response.status}): ${text.slice(0, 240)}`);
  }
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!cacheControl.includes("no-store") || response.headers.get("pragma") !== "no-cache") {
    throw new Error("desktop pairing smoke response is missing sensitive cache headers");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("desktop pairing smoke returned invalid JSON");
  }
  if (
    typeof body.pairing_id !== "string" ||
    !/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(body.user_code ?? "") ||
    typeof body.device_code !== "string" ||
    body.expires_in !== 300 ||
    body.interval !== 3
  ) {
    throw new Error("desktop pairing smoke returned an invalid Device Flow contract");
  }
  const verificationOrigin = new URL(body.verification_uri).origin;
  if (verificationOrigin !== base.origin) {
    throw new Error(`desktop pairing smoke verification origin mismatch: ${verificationOrigin}`);
  }
  return { pairingId: body.pairing_id, origin: base.origin };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const base = process.env.AGENTPARTY_SMOKE_BASE;
  if (!base) throw new Error("AGENTPARTY_SMOKE_BASE is required");
  const result = await smokeDesktopPairing(base);
  console.log(`desktop pairing smoke ok: ${result.origin}`);
}
