// #737:worker 的 `status --task N` 报自己那端的进度,blocked 不该拉黑父任务全局 state。
import { describe, expect, test } from "bun:test";
import { taskStateFromReportedStatus } from "../src/rest";

describe("taskStateFromReportedStatus (#737)", () => {
  test("blocked → null:不传播到父任务全局 state(由 host 用 party task block 决定)", () => {
    expect(taskStateFromReportedStatus("blocked")).toBeNull();
  });

  test("working → in_progress、waiting → assigned:非阻塞进度仍映射并传播", () => {
    expect(taskStateFromReportedStatus("working")).toBe("in_progress");
    expect(taskStateFromReportedStatus("waiting")).toBe("assigned");
  });

  test("done 原样传播(完成仍需能推进任务)", () => {
    expect(taskStateFromReportedStatus("done")).toBe("done");
  });
});
