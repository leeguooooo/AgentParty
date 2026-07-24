export interface CharterRequestGeneration {
  read: number;
  write: number;
  pendingWrite: number | null;
}

export interface CharterReadRequest {
  read: number;
  write: number;
}

export function createCharterRequestGeneration(): CharterRequestGeneration {
  return { read: 0, write: 0, pendingWrite: null };
}

export function beginCharterRead(generation: CharterRequestGeneration): CharterReadRequest {
  return {
    read: ++generation.read,
    write: generation.write,
  };
}

export function canApplyCharterRead(
  generation: CharterRequestGeneration,
  request: CharterReadRequest,
): boolean {
  return (
    request.read === generation.read
    && request.write === generation.write
    && generation.pendingWrite === null
  );
}

export function beginCharterWrite(generation: CharterRequestGeneration): number | null {
  if (generation.pendingWrite !== null) return null;
  generation.read += 1;
  const requestId = ++generation.write;
  generation.pendingWrite = requestId;
  return requestId;
}

export function canApplyCharterWrite(
  generation: CharterRequestGeneration,
  requestId: number,
): boolean {
  return generation.write === requestId && generation.pendingWrite === requestId;
}

export function commitCharterWrite(
  generation: CharterRequestGeneration,
  requestId: number,
): boolean {
  if (!canApplyCharterWrite(generation, requestId)) return false;
  // A GET may have started while the PUT was pending and observed the previous
  // snapshot. Invalidate it before publishing the successful write locally.
  generation.read += 1;
  return true;
}

export function finishCharterWrite(
  generation: CharterRequestGeneration,
  requestId: number,
): boolean {
  if (!canApplyCharterWrite(generation, requestId)) return false;
  // Reads started while this write was pending must stay obsolete even when
  // the PUT fails. Otherwise a late old snapshot can clear the write error and
  // replace the user's draft immediately after the failure is reported.
  generation.read += 1;
  generation.pendingWrite = null;
  return true;
}

export function invalidateCharterRequests(generation: CharterRequestGeneration): void {
  generation.read += 1;
  generation.write += 1;
  generation.pendingWrite = null;
}
