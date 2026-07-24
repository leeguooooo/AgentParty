import { describe, expect, test } from "bun:test";
import {
  extractIndexDefinition,
  extractTriggerDefinition,
  normalizeSqlDefinition,
} from "../worker/scripts/schema-contract.mjs";

describe("remote schema SQL contract helpers", () => {
  test("extracts a mixed-case trigger through its top-level END marker", () => {
    const source = `
CrEaTe TrIgGeR decision_guard
BEFORE INSERT ON decisions
BEGIN
  SELECT CASE
    WHEN NEW.id IS NULL
    THEN RAISE(ABORT, 'missing id')
  END;
END;

CREATE TRIGGER later_trigger AFTER INSERT ON decisions BEGIN SELECT 1; END;
`;

    const definition = extractTriggerDefinition(source, "decision_guard");
    expect(definition).toContain("CrEaTe TrIgGeR decision_guard");
    expect(definition).toContain("  END;");
    expect(definition?.trimEnd().endsWith("\nEND;")).toBe(true);
    expect(definition).not.toContain("later_trigger");
  });

  test("trigger extraction fails closed for a missing name or top-level END", () => {
    expect(extractTriggerDefinition("CREATE TRIGGER present BEFORE INSERT ON t BEGIN\nEND;", "missing"))
      .toBeNull();
    expect(extractTriggerDefinition("CREATE TRIGGER broken BEFORE INSERT ON t BEGIN\n  SELECT 1;", "broken"))
      .toBeNull();
  });

  test("extracts ordinary and unique indexes and requires a terminator", () => {
    const source = `
create unique index IDX_ONE
  on records(owner, id)
  where owner is not null;
CREATE INDEX idx_two ON records(created_at DESC);
`;
    expect(extractIndexDefinition(source, "idx_one")).toContain("where owner is not null;");
    expect(extractIndexDefinition(source, "IDX_TWO")).toBe(
      "CREATE INDEX idx_two ON records(created_at DESC);",
    );
    expect(extractIndexDefinition("CREATE INDEX broken ON records(id)", "broken")).toBeNull();
    expect(extractIndexDefinition(source, "missing")).toBeNull();
  });

  test("normalizes comments, whitespace, casing, and a trailing semicolon", () => {
    expect(normalizeSqlDefinition(`
      CREATE  TRIGGER guard -- deployment-only comment
      BEFORE INSERT ON records
      BEGIN
        SELECT RAISE(ABORT, 'NOPE');
      END;
    `)).toBe(
      "create trigger guard before insert on records begin select raise(abort, 'nope'); end",
    );
    expect(normalizeSqlDefinition(null)).toBe("");
  });
});
