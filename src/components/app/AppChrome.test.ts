import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Radix menus mount their content only on the client (Portal) and there is no DOM environment here, so pin
// the chrome contracts on the source instead.
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const chrome = read("src/components/app/AppChrome.tsx");
const settingsMenu = read("src/components/app/SettingsMenu.tsx");
const menu = read("src/components/ui/Menu.tsx");
// Joined so the removed name itself never appears in src (a grep for it must come back empty).
const REMOVED_SUBMENU = ["Menu", "Sub"].join("");

describe("desktop sidebar offset (R3-08)", () => {
  it("sticks at the position it already rests at, so it does not jump when scrolling starts", () => {
    // 59px header + the wrapper's 24px py-6 = 83px = 5.1875rem (was top-20 = 80px: a 3px jump).
    expect(chrome).toMatch(/<nav className="sticky top-\[5\.1875rem\] flex flex-col gap-1">/);
    expect(chrome).not.toContain("sticky top-20");
  });
});

describe("user menu settings (R3-31)", () => {
  it("renders the theme and language pickers as sections of the menu, not a submenu", () => {
    expect(settingsMenu).not.toContain(REMOVED_SUBMENU);
    expect(settingsMenu).not.toContain('useTranslations("Nav")');
    expect(settingsMenu).toContain("<>");
    expect(settingsMenu.match(/<MenuRadioGroup /g)).toHaveLength(2);
    expect(settingsMenu.match(/<MenuLabel>/g)).toHaveLength(2);
  });

  it("caps the menu at the room Radix has left and scrolls, so Log out stays reachable on a short viewport", () => {
    expect(menu).toContain("max-h-[var(--radix-dropdown-menu-content-available-height)]");
    expect(menu).toContain("overflow-y-auto");
  });

  it("no longer exports the unused submenu wrapper", () => {
    expect(menu).not.toContain(REMOVED_SUBMENU);
    expect(menu).not.toContain("DropdownMenu.Sub");
  });
});
