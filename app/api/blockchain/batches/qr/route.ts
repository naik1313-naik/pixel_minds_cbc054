import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { json, error } from "@/lib/api-utils";
import { guard } from "@/lib/api-utils";

export const runtime = "nodejs";

/**
 * Returns a QR code for a batch verification URL.
 *
 * The QR encodes only a public URL containing the opaque batch reference. It
 * exposes no customer data, no credentials, no database details and no private
 * keys — scanning it leads to the public /verify page.
 */
export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  void ctx;
  const batchRef = new URL(req.url).searchParams.get("batchRef");
  if (!batchRef || batchRef.length > 64) return error(400, "A batchRef query parameter is required");

  const origin =
    process.env.NEXT_PUBLIC_APP_ORIGIN?.replace(/\/$/, "") || new URL(req.url).origin;
  const verifyUrl = `${origin}/verify/${encodeURIComponent(batchRef)}`;

  const svg = await QRCode.toString(verifyUrl, {
    type: "svg",
    margin: 1,
    width: 240,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });

  return new Response(svg, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      // Never cache a QR for a batch that may later be revoked.
      "cache-control": "no-store",
    },
  });
});
