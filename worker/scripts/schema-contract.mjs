function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractTriggerDefinition(source, name) {
  const start = new RegExp(`^CREATE\\s+TRIGGER\\s+${escapeRegExp(name)}\\b`, "im").exec(source);
  if (start === null) return null;
  const tail = source.slice(start.index);
  const end = /^END;[ \t]*$/m.exec(tail);
  if (end === null) return null;
  return tail.slice(0, end.index + end[0].length);
}

export function extractIndexDefinition(source, name) {
  const start = new RegExp(
    `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${escapeRegExp(name)}\\b`,
    "im",
  ).exec(source);
  if (start === null) return null;
  const tail = source.slice(start.index);
  const end = tail.indexOf(";");
  return end === -1 ? null : tail.slice(0, end + 1);
}

export function normalizeSqlDefinition(sql) {
  if (typeof sql !== "string") return "";
  return sql
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

export function equivalentTriggerDefinitions(sql) {
  const normalized = normalizeSqlDefinition(sql);
  if (normalized.length === 0) return [];

  const legacyBareCase = normalized.replace(
    /\bselect\s+\(\s*case\b(.*?)\bend\s*\)\s*;/g,
    "select case$1end;",
  );
  return legacyBareCase === normalized
    ? [normalized]
    : [normalized, legacyBareCase];
}
