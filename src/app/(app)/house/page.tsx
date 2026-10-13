"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Card, ReceiptDivider, SectionTitle } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { MemberDot } from "@/components/ui/Member";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Stamp";
import { Spinner } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { SUPPORTED_CURRENCIES } from "@/lib/currencies";
import { useApiError } from "@/lib/api-errors";
import type { Member } from "@/lib/types";

export default function HousePage() {
  const t = useTranslations("Household");
  const tc = useTranslations("Common");
  const { me, activeGroup, members, membersLoading, refresh, refreshMembers, switchGroup } =
    useSession();
  const toast = useToast();
  const tcur = useTranslations("Currency");
  const apiErr = useApiError();

  function roleLabel(role: "ADMIN" | "MEMBER"): string {
    return role === "ADMIN" ? t("admin") : t("member");
  }

  // Regenerate code (ADMIN)
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);

  // Switch house
  const [switchingId, setSwitchingId] = useState<number | null>(null);

  // Create new house
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Join with code
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinCodeError, setJoinCodeError] = useState<string | null>(null);

  // Currency (ADMIN)
  const [savingCurrency, setSavingCurrency] = useState(false);

  // Leave house (self) / remove member (admin) — BL-16
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);
  // Make admin (spec 006) — confirmation first: the app has no way to undo a promotion.
  const [promoteTarget, setPromoteTarget] = useState<Member | null>(null);
  const [promoting, setPromoting] = useState(false);

  if (!me || !activeGroup) return null;

  const isAdmin = activeGroup.role === "ADMIN";
  const code = activeGroup.joinCode;
  const activeMembers = members.filter((m) => m.active);
  const exMembers = members.filter((m) => !m.active);

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast(t("codeCopied"), "success");
    } catch {
      toast(t("copyFailed"), "error");
    }
  }

  async function regenerateCode() {
    setRegenerating(true);
    try {
      await api.post("/api/groups/active/regenerate-code");
      await refresh();
      toast(t("codeGenerated"), "success");
    } catch (err) {
      toast(apiErr(err, t("codeGenerateError")), "error");
    } finally {
      setRegenerating(false);
      setRegenerateConfirmOpen(false);
    }
  }

  async function onSwitch(groupId: number) {
    if (!activeGroup || groupId === activeGroup.id) return;
    setSwitchingId(groupId);
    try {
      await switchGroup(groupId);
      toast(t("activeHouseChanged"), "success");
    } catch (err) {
      toast(apiErr(err, t("switchError")), "error");
    } finally {
      setSwitchingId(null);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await api.post("/api/groups", { name });
      await refresh();
      setNewName("");
      setCreateOpen(false);
      toast(t("houseCreated"), "success");
    } catch (err) {
      toast(apiErr(err, t("createError")), "error");
    } finally {
      setCreating(false);
    }
  }

  async function onJoin(e: React.FormEvent) {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (c.length !== 6) return;
    setJoining(true);
    setJoinCodeError(null);
    try {
      await api.post("/api/groups/join", { code: c });
      await refresh();
      setJoinCode("");
      toast(t("youJoined"), "success");
    } catch (err) {
      // U11: a bad format or an unknown code is a problem with what's in the field, not a
      // surprise event — show it under the input instead of a toast that disappears.
      if (err instanceof ApiError && (err.code === "INVALID_CODE_FORMAT" || err.code === "INVALID_CODE")) {
        setJoinCodeError(apiErr(err, t("joinError")));
      } else {
        toast(apiErr(err, t("joinError")), "error");
      }
    } finally {
      setJoining(false);
    }
  }

  async function onCurrency(value: string) {
    setSavingCurrency(true);
    try {
      await api.post("/api/groups/active/currency", { currency: value });
      await refresh();
      toast(tcur("changed"), "success");
    } catch (err) {
      toast(apiErr(err, tcur("error")), "error");
    } finally {
      setSavingCurrency(false);
    }
  }

  async function onLeave() {
    setLeaving(true);
    try {
      await api.post("/api/groups/active/leave");
      toast(t("leaveSuccess"), "success");
      setLeaveConfirmOpen(false);
      await refresh();
    } catch (err) {
      toast(apiErr(err, t("leaveError")), "error");
    } finally {
      setLeaving(false);
    }
  }

  async function onRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.del(`/api/groups/active/members/${removeTarget.publicId}`);
      toast(t("removeSuccess", { name: removeTarget.name }), "success");
      setRemoveTarget(null);
      await Promise.all([refresh(), refreshMembers()]);
    } catch (err) {
      toast(apiErr(err, t("removeError")), "error");
    } finally {
      setRemoving(false);
    }
  }

  async function onPromote() {
    if (!promoteTarget) return;
    setPromoting(true);
    try {
      await api.patch(`/api/groups/active/members/${promoteTarget.publicId}`, { role: "ADMIN" });
      toast(t("makeAdminSuccess", { name: promoteTarget.name }), "success");
      setPromoteTarget(null);
      await Promise.all([refresh(), refreshMembers()]);
    } catch (err) {
      toast(apiErr(err, t("makeAdminError")), "error");
    } finally {
      setPromoting(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* 1 — Header: active house + role */}
      <section className="flex flex-col gap-4">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Card className="reveal flex items-center gap-3 p-4">
          <MemberDot
            colorIndex={activeGroup.colorIndex}
            name={activeGroup.name}
            size={40}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {/* h2, not h1 — the page's h1 is the "House" title above; this is the active
                  house's own name, one level below it (U7/BL-33: exactly one h1 per page). */}
              <h2 className="break-words font-display text-lg font-bold text-ink">
                {activeGroup.name}
              </h2>
              <Tag>{roleLabel(activeGroup.role)}</Tag>
            </div>
            <p className="label-mono mt-0.5">{t("activeHouse")}</p>
          </div>
        </Card>
      </section>

      {/* 2 — Invite / join code */}
      <section className="flex flex-col gap-4">
        <SectionTitle>{t("invite")}</SectionTitle>
        <Card className="reveal p-4">
          {isAdmin && code ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="label-mono mb-2">{t("joinCodeLabel")}</p>
                <div className="rule-dashed flex items-baseline gap-3 pb-3">
                  <span className="font-mono text-3xl font-bold uppercase tracking-[0.35em] text-ink tnum">
                    {code}
                  </span>
                </div>
                <p className="mt-2 text-sm text-faint">
                  {t("shareCode")}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={copyCode}>
                  {tc("copy")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={regenerating}
                  onClick={() => setRegenerateConfirmOpen(true)}
                >
                  {t("regenerateCode")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint">
              {t("adminOnlyNote")}
            </p>
          )}
        </Card>
      </section>

      {/* 2b — Currency */}
      <section className="flex flex-col gap-4">
        <SectionTitle>{tcur("title")}</SectionTitle>
        <Card className="reveal p-4">
          {/* T5: the section title above already reads "Currency" — a visible field label would
              just repeat it. Kept for screen readers via sr-only. */}
          {isAdmin ? (
            <Field label={<span className="sr-only">{tcur("title")}</span>} htmlFor="currency" hint={tcur("hint")}>
              <Select
                id="currency"
                value={activeGroup.currency}
                disabled={savingCurrency}
                onChange={(e) => onCurrency(e.target.value)}
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {tcur(c)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-ink">{tcur(activeGroup.currency)}</p>
              <p className="text-sm text-faint">{tcur("adminOnly")}</p>
            </div>
          )}
        </Card>
      </section>

      {/* 3 — Members (active only; ex-members get their own section below, BL-16) */}
      <section className="flex flex-col gap-4">
        <SectionTitle right={<span className="label-mono">{activeMembers.length}</span>}>
          {t("members")}
        </SectionTitle>
        <Card className="reveal p-2">
          {membersLoading ? (
            <SkeletonRows rows={3} className="px-2" />
          ) : activeMembers.length === 0 ? (
            <p className="px-2 py-6 text-sm text-faint">{t("noMembers")}</p>
          ) : (
            <ul>
              {activeMembers.map((m, i) => {
                const isSelf = m.id === me.user.id;
                return (
                  <li key={m.id} className="reveal" style={revealDelay(i)}>
                    {i > 0 && <ReceiptDivider />}
                    {/* U7 → R3-28: below sm the role tag sits under the username (like "Your houses"), so
                        the trailing action (⋯ / "Leave house") stays on the first line — it used to drop
                        to a line of its own, leaving the ⋯ alone in an empty strip. From sm up the tag
                        keeps its fixed-width column and the action its sm:w-44 slot (a no-action row
                        reserves the same slot), so both columns line up between rows. */}
                    <div className="flex items-center gap-3 px-2 py-3">
                      <MemberDot colorIndex={m.colorIndex} name={m.name} size={32} />
                      <div className="min-w-0 flex-1">
                        {/* Round 2 (U7 residual): below sm the name wraps to up to 2 lines instead
                            of being cut with an ellipsis ("Júlia Caminho Feliz" at 360px). max-sm:
                            and sm: are exact complements, so line-clamp-2 (below sm) and truncate
                            (sm up, unchanged) never apply to the same viewport — no conflicting
                            utilities, no reliance on source order. */}
                        <p className="text-sm font-medium text-ink max-sm:line-clamp-2 max-sm:break-words sm:truncate">
                          {m.name}
                        </p>
                        <p className="truncate text-xs text-faint">@{m.username}</p>
                        <span className="mt-1 inline-block sm:hidden"><Tag>{roleLabel(m.role)}</Tag></span>
                      </div>
                      {/* R2-13: right-aligned, so tag, "Leave house" and ⋯ end on the same edge. */}
                      <div className="hidden w-20 shrink-0 text-right sm:block">
                        <Tag>{roleLabel(m.role)}</Tag>
                      </div>
                      {isSelf ? (
                        <button
                          type="button"
                          onClick={() => setLeaveConfirmOpen(true)}
                          // min-h-11: 44px touch floor on mobile (D3 — destructive action was 18px
                          // tall); md:min-h-0 restores the compact desktop size. R3-28: no w-full
                          // below sm — it stays on the first line.
                          // sm:w-44 (controller, round 1): fixed width fitting the longest of the 4
                          // locales' label ("Quitter la maison") so the role-tag column before it
                          // lands at the same x on every row instead of shifting with this label's
                          // own natural width (which differs a lot from the ⋯ menu button below).
                          className="label-mono inline-flex min-h-11 shrink-0 items-center justify-end whitespace-nowrap text-debt hover:underline sm:w-44 md:min-h-0"
                        >
                          {t("leave")}
                        </button>
                      ) : isAdmin ? (
                        <div className="flex shrink-0 justify-end sm:w-44">
                          <Menu
                            trigger={
                              <button
                                type="button"
                                aria-label={t("memberActions", { name: m.name })}
                                className="-mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-end rounded-sm px-2 py-1 text-lg leading-none text-faint transition-colors hover:bg-panel hover:text-ink md:min-h-0 md:min-w-0"
                              >
                                ⋯
                              </button>
                            }
                          >
                            {m.role !== "ADMIN" && (
                              <>
                                <MenuItem onSelect={() => setPromoteTarget(m)}>{t("makeAdmin")}</MenuItem>
                                <MenuSeparator />
                              </>
                            )}
                            <MenuItem danger onSelect={() => setRemoveTarget(m)}>
                              {t("remove")}
                            </MenuItem>
                          </Menu>
                        </div>
                      ) : (
                        // Controller round 2: a regular member viewing another regular member has
                        // no trailing action at all. Reserve the same sm:w-44 slot (hidden and
                        // takes no space below sm, so phones are unaffected) so the role-tag
                        // column before it still lands at the same x as the two branches above.
                        <div className="hidden sm:block sm:w-44" aria-hidden />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {/* 3b — Ex-members (BL-16): kept visible so a locked balance stays traceable to who it
          belongs to; never selectable for new expenses. */}
      {exMembers.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionTitle right={<span className="label-mono">{exMembers.length}</span>}>
            {t("exMembersTitle")}
          </SectionTitle>
          <Card className="reveal p-2">
            <ul>
              {exMembers.map((m, i) => (
                <li key={m.id} className="reveal" style={revealDelay(i)}>
                  {i > 0 && <ReceiptDivider />}
                  <div className="flex items-center gap-3 px-2 py-3 opacity-70">
                    <MemberDot colorIndex={m.colorIndex} name={m.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {t("exMemberLabel", { name: m.name })}
                      </p>
                      <p className="truncate text-xs text-faint">@{m.username}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* 4 — Your houses / switch */}
      <section className="flex flex-col gap-4">
        <SectionTitle
          right={
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
              {t("newHouse")}
            </Button>
          }
        >
          {t("yourHouses")}
        </SectionTitle>
        <Card className="reveal p-2">
          <ul>
            {me.user.groups.map((g, i) => {
              const active = g.id === activeGroup.id;
              return (
                <li key={g.id} className="reveal" style={revealDelay(i)}>
                  {i > 0 && <ReceiptDivider />}
                  <button
                    type="button"
                    disabled={active || switchingId != null}
                    onClick={() => onSwitch(g.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2 py-3 text-left transition-colors",
                      active
                        ? "cursor-default bg-panel"
                        : "hover:bg-panel disabled:opacity-60"
                    )}
                  >
                    <MemberDot colorIndex={g.colorIndex} name={g.name} size={32} />
                    <div className="min-w-0 flex-1">
                      {/* R2-31: same rule as the house card and Members — 2 lines below sm, truncate from sm up. */}
                      <p className="text-sm font-medium text-ink max-sm:line-clamp-2 max-sm:break-words sm:truncate">{g.name}</p>
                      <span className="mt-1 inline-block">
                        <Tag>{roleLabel(g.role)}</Tag>
                      </span>
                    </div>
                    {switchingId === g.id ? (
                      <Spinner />
                    ) : active ? (
                      <span className="label-mono text-stamp-text">{t("activeMark")}</span>
                    ) : (
                      <span className="label-mono">{t("switch")}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      {/* 5 — Join with code */}
      <section className="flex flex-col gap-4">
        <SectionTitle>{t("joinWithCode")}</SectionTitle>
        <Card className="reveal p-4">
          <form onSubmit={onJoin} className="flex flex-col gap-3">
            <Field
              label={t("codeFieldLabel")}
              htmlFor="join-code"
              hint={t("codeFieldHint")}
              error={joinCodeError}
            >
              <Input
                id="join-code"
                value={joinCode}
                onChange={(e) => {
                  setJoinCode(e.target.value.toUpperCase().slice(0, 6));
                  if (joinCodeError) setJoinCodeError(null);
                }}
                maxLength={6}
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="ABC123"
                className="font-mono uppercase tracking-[0.35em]"
                aria-invalid={!!joinCodeError}
              />
            </Field>
            <Button
              type="submit"
              loading={joining}
              disabled={joinCode.trim().length !== 6}
              className="w-full"
            >
              {t("joinButton")}
            </Button>
            <p className="text-pretty text-xs text-faint">{t("joinHint")}</p>
          </form>
        </Card>
      </section>

      {/* Create house modal */}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t("createHouseTitle")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
            >
              {tc("cancel")}
            </Button>
            <Button
              form="create-house-form"
              type="submit"
              loading={creating}
              disabled={!newName.trim()}
            >
              {t("createButton")}
            </Button>
          </>
        }
      >
        <form id="create-house-form" onSubmit={onCreate}>
          <Field label={t("houseNameLabel")} htmlFor="house-name">
            <Input
              id="house-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={80}
              autoFocus
              required
              placeholder={t("houseNamePlaceholder")}
            />
          </Field>
        </form>
      </Modal>

      {/* Regenerate join code confirm */}
      <Modal
        open={regenerateConfirmOpen}
        onOpenChange={setRegenerateConfirmOpen}
        title={t("regenerateCodeConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRegenerateConfirmOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={regenerating} onClick={regenerateCode}>
              {t("regenerateCode")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t("regenerateConfirmPrompt")}</p>
      </Modal>

      {/* Leave house confirm (self, BL-16) */}
      <Modal
        open={leaveConfirmOpen}
        onOpenChange={(o) => !o && !leaving && setLeaveConfirmOpen(false)}
        title={t("leaveConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaveConfirmOpen(false)} disabled={leaving}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              loading={leaving}
              disabled={activeGroup.lastAdmin}
              onClick={onLeave}
            >
              {t("leave")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {/* spec 006: the server would refuse with LAST_ADMIN — say why up front (U18 warning style). */}
          {activeGroup.lastAdmin && (
            <p className="rounded-md bg-stamp-soft px-3 py-2 text-pretty text-sm text-ink">{t("lastAdminWarning")}</p>
          )}
          <p className="text-sm text-ink">{t("leaveConfirmPrompt")}</p>
        </div>
      </Modal>

      {/* Remove member confirm (admin, BL-16) */}
      <Modal
        open={removeTarget !== null}
        onOpenChange={(o) => !o && !removing && setRemoveTarget(null)}
        title={removeTarget ? t("removeConfirmTitle", { name: removeTarget.name }) : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)} disabled={removing}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" loading={removing} onClick={onRemove}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t("removeConfirmPrompt")}</p>
      </Modal>

      {/* Make admin confirm (spec 006) */}
      <Modal
        open={promoteTarget !== null}
        onOpenChange={(o) => !o && !promoting && setPromoteTarget(null)}
        title={promoteTarget ? t("makeAdminConfirmTitle", { name: promoteTarget.name }) : ""}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPromoteTarget(null)} disabled={promoting}>
              {tc("cancel")}
            </Button>
            <Button loading={promoting} onClick={onPromote}>
              {t("makeAdmin")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">{t("makeAdminConfirmPrompt")}</p>
      </Modal>
    </div>
  );
}
