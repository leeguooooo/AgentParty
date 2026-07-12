export type DesktopDistribution = "production" | "preview" | "development";

export interface DesktopReleaseInfo {
  distribution: DesktopDistribution;
  notarized: boolean;
}

type DesktopInvoker = <T>(command: string) => Promise<T>;

export function parseDesktopReleaseInfo(value: unknown): DesktopReleaseInfo {
  if (typeof value !== "object" || value === null) {
    return { distribution: "development", notarized: false };
  }
  const candidate = value as Partial<DesktopReleaseInfo>;
  const distribution = candidate.distribution;
  if (distribution !== "production" && distribution !== "preview" && distribution !== "development") {
    return { distribution: "development", notarized: false };
  }
  const notarized = candidate.notarized === true;
  if ((distribution === "production") !== notarized) {
    return { distribution: "development", notarized: false };
  }
  return { distribution, notarized };
}

const nativeInvoke: DesktopInvoker = async <T>(command: string) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command);
};

export async function loadDesktopReleaseInfo(invoke: DesktopInvoker = nativeInvoke): Promise<DesktopReleaseInfo> {
  try {
    return parseDesktopReleaseInfo(await invoke<unknown>("desktop_release_info"));
  } catch {
    return { distribution: "development", notarized: false };
  }
}
