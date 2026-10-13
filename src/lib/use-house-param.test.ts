import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The hook's React/Next dependencies are not exercised here (no DOM environment): only the pure decision is
// behavior-tested; the hook and the chrome are pinned on the source below.
vi.mock("next/navigation", () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock("@/lib/session", () => ({ useSession: vi.fn() }));

import { HOUSE_PARAM, houseParamAction, withoutHouseParam } from "./use-house-param";

// Opening the app from a push (spec 010 — criterion 12): the push URL is the notice's screen + ?house=<publicId>.
const A = { id: 1, publicId: "0192f0c4-0000-7000-8000-00000000000a" };
const B = { id: 2, publicId: "0192f0c4-0000-7000-8000-00000000000b" };
const GROUPS = [A, B];

describe("houseParamAction — what ?house= asks for", () => {
  it("is the 'house' query parameter (payload.ts writes ?house=<publicId>)", () => {
    expect(HOUSE_PARAM).toBe("house");
  });

  it("no parameter → nothing to do", () => {
    expect(houseParamAction(null, GROUPS, A.id)).toEqual({ type: "none" });
  });

  it("another house of this member → switch to it (membership checked by POST /api/groups/active)", () => {
    expect(houseParamAction(B.publicId, GROUPS, A.id)).toEqual({ type: "switch", groupId: B.id });
  });

  it("the active house → no switch, just drop the parameter", () => {
    expect(houseParamAction(A.publicId, GROUPS, A.id)).toEqual({ type: "drop" });
  });

  it.each([
    ["a house the member left (no longer in me.user.groups)", "0192f0c4-0000-7000-8000-00000000000c"],
    ["an empty value", ""],
    ["a house id instead of its publicId", "2"],
    ["another case of a known publicId", B.publicId.toUpperCase()],
    ["garbage", "<script>"],
  ])("%s → the active house stays, the parameter is dropped", (_label, house) => {
    expect(houseParamAction(house, GROUPS, A.id)).toEqual({ type: "drop" });
  });

  it("without houses every value is dropped", () => {
    expect(houseParamAction(B.publicId, [], null)).toEqual({ type: "drop" });
  });
});

describe("withoutHouseParam — the URL left after the decision", () => {
  it.each([
    ["?house=abc", ""],
    ["house=abc", ""],
    ["?house=abc&tab=detailed", "?tab=detailed"],
    ["tab=detailed&house=abc&page=2", "?tab=detailed&page=2"],
    ["?house=a&house=b", ""],
    ["?tab=detailed", "?tab=detailed"],
    ["", ""],
  ])("%j → %j", (search, expected) => {
    expect(withoutHouseParam(search)).toBe(expected);
  });
});

// The hook needs React + the App Router; pinned on the source (like notifications-ui.test.ts).
describe("useHouseParam + AppChrome (criterion 12): switch before the screen shows", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const hook = read("src/lib/use-house-param.ts");
  const chrome = read("src/components/app/AppChrome.tsx");

  it("reads ?house= with useSearchParams and decides from the session's houses and active house", () => {
    expect(hook).toContain("searchParams.get(HOUSE_PARAM)");
    expect(hook).toContain("houseParamAction(house, me?.user.groups ?? [], activeGroup?.id ?? null)");
  });

  it("switches through the session's switchGroup (POST /api/groups/active), once per value, and survives a refusal", () => {
    expect(hook).toContain("switchGroup(target)");
    expect(hook).toMatch(/switchGroup\(target\)\s*\.catch\(\(\) => \{\}\)\s*\.finally\(\(\) => setTried\(house\)\)/);
    expect(hook).toContain("inFlight.current === house");
    expect(hook).not.toContain('api.post("/api/groups/active"');
  });

  it("then replaces the URL without the parameter (no history entry, no scroll jump)", () => {
    expect(hook).toContain("router.replace(`${pathname}${withoutHouseParam(searchParams.toString())}`, { scroll: false })");
  });

  it("reports the switch as pending until it ran", () => {
    expect(hook).toMatch(/return target !== null && tried !== house;/);
  });

  it("the chrome holds the page back while the switch is pending (never shows the other house first)", () => {
    expect(chrome).toContain('import { useHouseParam } from "@/lib/use-house-param";');
    expect(chrome).toContain("const switchingHouse = useHouseParam();");
    expect(chrome).toMatch(/<main className="min-w-0 flex-1 pb-6">\s*\{switchingHouse \? \(/);
    expect(chrome).toMatch(/: \(\s*children\s*\)\}\s*<\/main>/);
  });
});
