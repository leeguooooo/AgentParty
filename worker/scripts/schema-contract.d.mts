export function extractTriggerDefinition(source: string, name: string): string | null;
export function extractIndexDefinition(source: string, name: string): string | null;
export function normalizeSqlDefinition(sql: unknown): string;
export function equivalentTriggerDefinitions(sql: unknown): string[];
