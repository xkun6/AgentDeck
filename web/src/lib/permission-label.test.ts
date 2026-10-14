import { describe, expect, it } from "vitest";
import { pendingPermissionLabel, waitingPermissionLabel } from "./permission-label";

describe("permission-label", () => {
  it("按审批类型区分标签：question / plan / elicitation / 其它", () => {
    expect(pendingPermissionLabel("question")).toBe("待回答");
    expect(pendingPermissionLabel("plan")).toBe("待确认计划");
    expect(pendingPermissionLabel("elicitation")).toBe("待填写");
    expect(pendingPermissionLabel("tool")).toBe("待审批");
    expect(pendingPermissionLabel()).toBe("待审批");
    expect(waitingPermissionLabel("question")).toBe("等待回答");
    expect(waitingPermissionLabel("plan")).toBe("等待确认计划");
    expect(waitingPermissionLabel("elicitation")).toBe("等待填写");
    expect(waitingPermissionLabel("mode")).toBe("等待审批");
  });
});
