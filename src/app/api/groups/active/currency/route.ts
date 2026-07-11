import { NextResponse } from "next/server";
import { groupService } from "@/services/group.service";
import { handleApiError, requireActiveGroup, recordActivity } from "@/lib/api-helpers";
import { isCurrency } from "@/lib/currencies";

/** Set the active house currency (ADMIN only). Display-only — no FX conversion. */
export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup();
    if (!check.ok) return check.response;

    if (check.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Only the house admin can change the currency", code: "NOT_ADMIN" },
        { status: 403 }
      );
    }

    const body = await request.json();
    if (!isCurrency(body.currency)) {
      return NextResponse.json(
        { error: "Invalid currency", code: "INVALID_CURRENCY" },
        { status: 400 }
      );
    }

    await groupService.updateCurrency(check.groupId, body.currency);

    await recordActivity({
      groupId: check.groupId,
      actorId: check.session.userId,
      entityType: 'GROUP',
      action: 'UPDATE',
      summary: body.currency,
      changes: { currency: { to: body.currency } },
    });

    return NextResponse.json({ currency: body.currency });
  } catch (error) {
    return handleApiError(error, "Failed to change currency");
  }
}
