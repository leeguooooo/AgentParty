export interface DeploymentMetadata {
  version: string;
  commit: string;
  deployed_at: string;
}

export interface DeploymentVerificationOptions {
  attempts?: number;
  consecutive?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export type DeploymentFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function validateDeploymentMetadata(metadata: DeploymentMetadata): DeploymentMetadata;
export function deploymentDefineArgs(metadata: DeploymentMetadata): string[];
export function readDeploymentMetadata(
  base: string,
  fetcher?: DeploymentFetch,
): Promise<DeploymentMetadata>;
export function verifyDeploymentMetadata(
  base: string,
  expected: DeploymentMetadata,
  fetcher?: DeploymentFetch,
  options?: DeploymentVerificationOptions,
): Promise<DeploymentMetadata>;
export function verifyDeploymentIdentity(
  base: string,
  expected: Pick<DeploymentMetadata, "version" | "commit">,
  fetcher?: DeploymentFetch,
  options?: DeploymentVerificationOptions,
): Promise<DeploymentMetadata>;
export function verifyDualDeployment(
  targets: Record<string, string>,
  expected: DeploymentMetadata,
  fetcher?: DeploymentFetch,
  options?: DeploymentVerificationOptions,
): Promise<Record<string, DeploymentMetadata>>;
