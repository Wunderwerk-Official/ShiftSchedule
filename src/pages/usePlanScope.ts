import { useState } from "react";
import type { PlanScope } from "../api/client";

/**
 * Page scope "Team | My plan" (plan §2.1): page state only, never stored.
 * The calendar always opens in "team". Since v1.71 the stored start views
 * (`startViewDesktop` / `startViewMobile`) are ignored: there is no control
 * left to unset one, so applying it could pin a user to My plan for good.
 */
export function usePlanScope() {
  const [planScope, setPlanScope] = useState<PlanScope>("team");
  return { planScope, setPlanScope };
}
