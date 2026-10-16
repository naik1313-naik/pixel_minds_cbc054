import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { guard, error } from "@/lib/api-utils";
import { canViewRequest } from "@/lib/access";
import { getRequestDetail } from "@/lib/engine";
import { getPaymentForRequest, getPaymentAudit } from "@/lib/payments";

export const runtime = "nodejs";

/**
 * QR code for a settled payment receipt.
 *
 * Encodes the public verification URL, not the payment details: a receipt that
 * a customer can hold up and a stranger can scan is the whole point, and it only
 * works because nothing identifying is in the code itself.
 *
 * Returned as an SVG so it stays sharp when the pharmacy prints it.
 */
export const GET = guard(null, async (ctx, _req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");

  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, { ...detail.request, id }))) return error(403, "Forbidden");

  const payment = await getPaymentForRequest(id);
  if (!payment) return error(404, "This request has no payment");
  const audit = await getPaymentAudit(payment.id);
  if (!audit?.settlement_ref) {
    // Before the payout is anchored there is nothing on-chain to point a QR at.
    return error(409, "A receipt QR is available once the payment has been settled");
  }

  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN ?? new URL(_req.url).origin;
  const target = `${origin.replace(/\/$/, "")}/verify/settlement/${audit.settlement_ref}`;

  const svg = await QRCode.toString(target, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  // qrcode emits a viewBox but no intrinsic width/height, which renders as a
  // blank box inside an <img> in some browsers. Fixed size keeps it crisp enough
  // to scan on a printed receipt and sharp at any display size.
  const sized = svg.replace(
    "<svg ",
    '<svg width="256" height="256" role="img" aria-label="QR code linking to the public settlement verification" '
  );

  return new NextResponse(sized, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // The target changes once per settlement, so it must not be cached forever.
      "cache-control": "private, max-age=300",
    },
  });
});