import { NextResponse } from "next/server";
import { groupService } from "@/services/group.service";
import { handleApiError, requireActiveGroup } from "@/lib/api-helpers";
import { isCurrency } from "@/lib/currencies";

/** Set the active house currency (ADMIN only). Display-only — no FX conversion. */
export async function POST(request: Request) {
  try {
    const check = await requireActiveGroup();
    if (!check.ok) return check.response;

    if (check.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Apenas o admin da casa pode mudar a moeda", code: "NOT_ADMIN" },
        { status: 403 }
      );
    }

    const body = await request.json();
    if (!isCurrency(body.currency)) {
      return NextResponse.json(
        { error: "Moeda inválida", code: "INVALID_CURRENCY" },
        { status: 400 }
      );
    }

    await groupService.updateCurrency(check.groupId, body.currency);
    return NextResponse.json({ currency: body.currency });
  } catch (error) {
    return handleApiError(error, "Erro ao mudar a moeda");
  }
}
