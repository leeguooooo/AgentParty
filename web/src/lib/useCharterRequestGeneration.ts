import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginCharterWrite,
  createCharterRequestGeneration,
  finishCharterWrite,
  invalidateCharterRequests,
} from "./charterRequestGeneration";

export function useCharterRequestGeneration(slug: string) {
  const generationRef = useRef(createCharterRequestGeneration());
  const [saving, setSaving] = useState(false);

  const beginWrite = useCallback(() => {
    const requestId = beginCharterWrite(generationRef.current);
    if (requestId !== null) setSaving(true);
    return requestId;
  }, []);

  const finishWrite = useCallback((requestId: number) => {
    if (!finishCharterWrite(generationRef.current, requestId)) return false;
    setSaving(false);
    return true;
  }, []);

  useEffect(() => {
    setSaving(false);
    return () => {
      invalidateCharterRequests(generationRef.current);
    };
  }, [slug]);

  return {
    generationRef,
    saving,
    beginWrite,
    finishWrite,
  };
}
