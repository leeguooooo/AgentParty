import { setApiBase } from "./base";
import { restoreDesktopAccess } from "./desktopAuth";
import {
  desktopCredentialVaultForOrigin,
  type DesktopCredentialVault,
} from "./desktopCredentials";
import {
  loadActiveServerOrigin,
  loadServerProfiles,
  normalizeServerOrigin,
  saveActiveServerOrigin,
  type ServerProfileStorage,
} from "./serverProfiles";

interface ServerSwitchDependencies {
  vaultForOrigin(origin: string): DesktopCredentialVault;
  restore(vault: DesktopCredentialVault, origin: string): Promise<string | null>;
  setRuntimeBase(origin: string): void;
}

const defaultDependencies: ServerSwitchDependencies = {
  vaultForOrigin: desktopCredentialVaultForOrigin,
  restore: restoreDesktopAccess,
  setRuntimeBase: setApiBase,
};

export interface DesktopServerPairingFlow {
  phase: "connected" | "adding" | "pairing";
  activeOrigin: string;
  targetOrigin: string | null;
}

export function initialDesktopServerPairingFlow(activeInput: string): DesktopServerPairingFlow {
  const activeOrigin = normalizeServerOrigin(activeInput);
  if (activeOrigin === null) throw new Error("active server origin is invalid");
  return { phase: "connected", activeOrigin, targetOrigin: null };
}

export function beginDesktopServerAdd(flow: DesktopServerPairingFlow): DesktopServerPairingFlow {
  return { phase: "adding", activeOrigin: flow.activeOrigin, targetOrigin: null };
}

export function beginDesktopServerPairing(
  flow: DesktopServerPairingFlow,
  targetInput: string,
): DesktopServerPairingFlow {
  const targetOrigin = normalizeServerOrigin(targetInput);
  if (targetOrigin === null) throw new Error("target server origin is invalid");
  return { phase: "pairing", activeOrigin: flow.activeOrigin, targetOrigin };
}

export function cancelDesktopServerPairing(flow: DesktopServerPairingFlow): DesktopServerPairingFlow {
  return { phase: "connected", activeOrigin: flow.activeOrigin, targetOrigin: null };
}

export function completeDesktopServerPairing(flow: DesktopServerPairingFlow): DesktopServerPairingFlow {
  if (flow.phase !== "pairing" || flow.targetOrigin === null) {
    throw new Error("no target server pairing is in progress");
  }
  return { phase: "connected", activeOrigin: flow.targetOrigin, targetOrigin: null };
}

export class DesktopServerNotPairedError extends Error {
  readonly origin: string;

  constructor(origin: string) {
    super("target server is not paired on this device");
    this.name = "DesktopServerNotPairedError";
    this.origin = origin;
  }
}

export async function switchActiveDesktopServer(
  targetInput: string,
  storage: ServerProfileStorage = localStorage,
  dependencies: ServerSwitchDependencies = defaultDependencies,
): Promise<{ origin: string; accessToken: string }> {
  const target = normalizeServerOrigin(targetInput);
  if (target === null || !loadServerProfiles(storage).some((profile) => profile.origin === target)) {
    throw new Error("target server profile is not registered");
  }

  const accessToken = await dependencies.restore(dependencies.vaultForOrigin(target), target);
  if (accessToken === null) throw new DesktopServerNotPairedError(target);

  const previous = loadActiveServerOrigin(storage);
  try {
    saveActiveServerOrigin(storage, target);
    dependencies.setRuntimeBase(target);
  } catch (error) {
    saveActiveServerOrigin(storage, previous);
    dependencies.setRuntimeBase(previous);
    throw error;
  }
  return { origin: target, accessToken };
}
