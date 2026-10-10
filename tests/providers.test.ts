import { describe, it, expect, vi, afterEach } from "vitest";
import { demoIdentityProvider, httpIdentityProvider } from "@/lib/providers";
import { verhoeffCheckDigit } from "@/lib/identity";

const validDl = { type: "DL", number: "KA0120180001234" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo IdentityProvider", () => {
  it("verifies a well-formed document offline", async () => {
    const res = await demoIdentityProvider.verify(validDl);
    expect(res.status).toBe("verified");
    expect(res.reference).toMatch(/^GOV-DL-/);
  });

  it("rejects a fabricated number", async () => {
    const res = await demoIdentityProvider.verify({ type: "PAN", number: "ABCPE0000F" });
    expect(res.status).toBe("invalid");
  });

  it("verifies a checksum-valid Aadhaar", async () => {
    const base = "23456789012";
    const res = await demoIdentityProvider.verify({ type: "Aadhaar", number: base + verhoeffCheckDigit(base) });
    expect(res.status).toBe("verified");
  });
});

describe("http IdentityProvider (production KYC hook)", () => {
  const provider = () => httpIdentityProvider("https://kyc.example/verify", "secret-key");

  it("maps an issued document to verified", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ found: true, reference: "KYC-123", nameMatch: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider().verify({ ...validDl, name: "Asha" });
    expect(res.status).toBe("verified");
    expect(res.reference).toBe("KYC-123");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
  });

  it("maps a not-found document to invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ found: false, note: "no record" }) })));
    const res = await provider().verify(validDl);
    expect(res.status).toBe("invalid");
  });

  it("treats a gateway outage as unverifiable, not invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const res = await provider().verify(validDl);
    expect(res.status).toBe("unverifiable");
  });

  it("treats a transport error as unverifiable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const res = await provider().verify(validDl);
    expect(res.status).toBe("unverifiable");
  });

  it("still rejects malformed documents without calling the gateway", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await provider().verify({ type: "DL", number: "not-a-licence" });
    expect(res.status).toBe("format_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
