"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/session";
import type { MeGroup } from "@/lib/types";

/** The query parameter a push URL names its house with (src/lib/push/payload.ts: screen + ?house=<publicId>). */
export const HOUSE_PARAM = "house";

export type HouseParamAction = { type: "none" } | { type: "drop" } | { type: "switch"; groupId: number };

/**
 * What `?house=` asks for (spec 010, criterion 12): a house of this member other than the active one → switch to it;
 * the active house, a house they left or any other value → just drop the parameter (the active house stays).
 */
export function houseParamAction(
  house: string | null,
  groups: readonly Pick<MeGroup, "id" | "publicId">[],
  activeGroupId: number | null
): HouseParamAction {
  if (house === null) return { type: "none" };
  const target = groups.find((group) => group.publicId === house);
  return !target || target.id === activeGroupId ? { type: "drop" } : { type: "switch", groupId: target.id };
}

/** The query string without `house` ("" when nothing else is left). */
export function withoutHouseParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(HOUSE_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Opening the app from a push (criterion 12): switches to the push's house through the session's switchGroup — POST
 * /api/groups/active, which checks membership, so the parameter never grants access and a refusal leaves the active
 * house as it was — then removes the parameter from the URL. Returns true while that switch is pending, so the chrome
 * holds the screen back instead of showing the other house first.
 */
export function useHouseParam(): boolean {
  const { me, activeGroup, switchGroup } = useSession();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const house = searchParams.get(HOUSE_PARAM);
  const action = houseParamAction(house, me?.user.groups ?? [], activeGroup?.id ?? null);
  const target = action.type === "switch" ? action.groupId : null;
  // The `house` value whose switch already ran (done or refused); the ref keeps a second run from starting meanwhile.
  const [tried, setTried] = useState<string | null>(null);
  const inFlight = useRef<string | null>(null);

  useEffect(() => {
    if (house === null) return;
    if (target !== null && tried !== house) {
      if (inFlight.current === house) return;
      inFlight.current = house;
      switchGroup(target)
        .catch(() => {})
        .finally(() => setTried(house));
      return;
    }
    router.replace(`${pathname}${withoutHouseParam(searchParams.toString())}`, { scroll: false });
  }, [house, target, tried, switchGroup, router, pathname, searchParams]);

  return target !== null && tried !== house;
}
