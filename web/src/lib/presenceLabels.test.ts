import { describe, expect, test } from "bun:test";
import { hostLeaseLabel, presenceStateLabel, residencyLabel } from "./presenceLabels";
import { PresenceLabelsStrings } from "../i18n/strings/PresenceLabels";

// 假 t：按 zh 词典查，缺键时回 key——这样既能验证映射到了人话，也能验证未知值不被吞。
const t = (key: string): string => PresenceLabelsStrings.zh[key] ?? key;

describe("模块⑧：presence 枚举给用户看时用人话", () => {
  test("已知值映射成人话", () => {
    expect(presenceStateLabel("working", t)).toBe("处理中");
    expect(residencyLabel("supervised", t)).toBe("常驻托管");
    expect(residencyLabel("human_driven", t)).toBe("手动");
    expect(residencyLabel("mixed", t)).toBe("混合");
    expect(hostLeaseLabel("stale", t)).toBe("主持权已失效");
  });
  test("未知值原样返回，空值返回空串", () => {
    expect(presenceStateLabel("hibernating", t)).toBe("hibernating");
    expect(residencyLabel("orbital", t)).toBe("orbital");
    expect(residencyLabel(null, t)).toBe("");
    expect(hostLeaseLabel(undefined, t)).toBe("");
  });
  test("en / zh 键集一致", () => {
    expect(Object.keys(PresenceLabelsStrings.en).sort()).toEqual(Object.keys(PresenceLabelsStrings.zh).sort());
  });
});
