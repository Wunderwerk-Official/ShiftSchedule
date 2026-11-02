import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePlanScope } from "./usePlanScope";

describe("usePlanScope", () => {
  it("always starts on the team plan and switches on request", () => {
    // Stored start views (startViewDesktop / startViewMobile) are ignored
    // since v1.74: the hook does not even read the preferences.
    const { result } = renderHook(() => usePlanScope());
    expect(result.current.planScope).toBe("team");
    act(() => result.current.setPlanScope("me"));
    expect(result.current.planScope).toBe("me");
    act(() => result.current.setPlanScope("team"));
    expect(result.current.planScope).toBe("team");
  });
});
