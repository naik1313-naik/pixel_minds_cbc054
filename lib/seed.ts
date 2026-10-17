import crypto from "crypto";
import fs from "fs";
import path from "path";
import { hashPasswordSync } from "./password";
import { encryptSecret, generateTotpSecret, totpUri } from "./crypto";
import { dataDir } from "./paths";
import { queryRun, queryRaw, queryReturning } from "./db";
import {
  verifyDocument,
  demoRegistryLookup,
  parseDocumentKind,
  normalizeDocument,
  verhoeffCheckDigit,
} from "./identity";
import { CATALOGUE as MEDICINES, type CatalogueEntry } from "./catalogue-data";


/** "500mg", or empty when the entry has no strength. */
function strengthLabel(m: CatalogueEntry): string {
  if (m.strengthValue === null || m.strengthValue === undefined) return "";
  return `${m.strengthValue}${m.strengthUnit ?? ""}`;
}

/**
 * A pharmacy's selling price for a catalogue entry.
 *
 * A per-pharmacy variation off the catalogue price, so the demo shows that
 * prices differ between shops. Every one of these figures is fictional.
 */
const pharmacyPriceOffsets = new Map<number, number>([
  [1, 0], [2, 1.04], [3, 0.97], [4, 1.08], [5, 1.02], [6, 0.99], [7, 1.06], [8, 0.95],
]);
let priceLookup = new Map<number, number>();

/** The list price of a catalogue entry, in paise. */
function cataloguePriceOf(medicineId: number): number {
  return priceLookup.get(medicineId) ?? 0;
}

/**
 * What pharmacy `pid` charges for a catalogue entry.
 *
 * Each shop prices differently; the offset is a fixed per-pharmacy multiplier on
 * the fictional list price. This is not a market price and does not claim to be.
 */
function pharmacyPriceFor(pid: number, medicineId: number): number {
  const offset = pharmacyPriceOffsets.get(pid) ?? 1;
  return Math.round(cataloguePriceOf(medicineId) * offset);
}

// Cleary-fictional demo data. No real patients, pharmacies, licences or people.

const PHARMACIES = [
  { id: 1, name: "Apollo Pharmacy (Demo)", address: "100 Ft Road, Indiranagar", lat: 12.9784, lng: 77.6408, lic: "KA-BLR-20B-0001", status: "verified", score: 0.95, fulfil: 240 },
  { id: 2, name: "MedPlus (Demo)", address: "Old Airport Road, Domlur", lat: 12.9609, lng: 77.6387, lic: "KA-BLR-20B-0002", status: "verified", score: 0.88, fulfil: 180 },
  { id: 3, name: "Wellness Forever (Demo)", address: "80 Ft Road, Koramangala", lat: 12.9352, lng: 77.6245, lic: "KA-BLR-20B-0003", status: "verified", score: 0.82, fulfil: 120 },
  { id: 4, name: "Trust Pharmacy (Demo)", address: "CMH Road, Halasuru", lat: 12.975, lng: 77.63, lic: "KA-BLR-20B-0004", status: "verified", score: 0.74, fulfil: 90 },
  { id: 5, name: "HealthMart (Demo)", address: "MG Road", lat: 12.9752, lng: 77.605, lic: "KA-BLR-20B-0005", status: "verified", score: 0.9, fulfil: 150 },
  { id: 6, name: "Care & Cure (Demo)", address: "11th Main, Jayanagar", lat: 12.9308, lng: 77.5833, lic: "KA-BLR-20B-0006", status: "verified", score: 0.68, fulfil: 70 },
  { id: 7, name: "Balaji Medicals (Demo)", address: "Dr Rajkumar Road, Rajajinagar", lat: 12.9916, lng: 77.556, lic: "KA-BLR-20B-0007", status: "verified", score: 0.6, fulfil: 55 },
  { id: 8, name: "City Drug House (Demo)", address: "ITPL Main Road, Whitefield", lat: 12.9698, lng: 77.75, lic: "KA-BLR-20B-0008", status: "verified", score: 0.8, fulfil: 40 },
];

// The catalogue lives in its own module so the import pipeline can read the
// exact same source. Inventory below refers to entries by catalogue position,
// never by a hardcoded id: adding a medicine must not silently repoint every
// stock row in the demo.
const CATALOGUE = MEDICINES;

/**
 * Catalogue entries the demo stocks.
 *
 * Addressed by a readable key rather than a number, because "paracetamol 650"
 * survives an edit to the catalogue and "[3]" does not.
 */
const STOCKED: Record<string, string> = {
  paracetamol500: "Paracetamol||500|Tablet",
  dolo650: "Paracetamol|Dolo 650|650|Tablet",
  crocin400: "Paracetamol|Crocin Advance|400|Tablet",
  brufen400: "Brufen|Ibuprofen|400|Tablet",
  ibuprofen400: "Ibuprofen||400|Tablet",
  aspirin75: "Aspirin|Ecosprin|75|Tablet",
  diclofenac50: "Diclofenac|Voveran|50|Tablet",
  paracetamolPaed: "Paracetamol (Paediatric)||125|Oral suspension",
  cetirizine10: "Cetirizine||10|Tablet",
  fexofenadine120: "Fexofenadine|Allegra|120|Tablet",
  montelukast10: "Montelukast|Montair|10|Tablet",
  amoxicillin500: "Amoxicillin|Mox|500|Capsule",
  azithromycin500: "Azithromycin|Azithral|500|Tablet",
  ciprofloxacin500: "Ciprofloxacin||500|Tablet",
  metformin500: "Metformin|Glycomet|500|Tablet",
  amlodipine5: "Amlodipine|Amlokind|5|Tablet",
  telmisartan40: "Telmisartan|Telma|40|Tablet",
  atorvastatin10: "Atorvastatin|Lipitor|10|Tablet",
  levothyroxine50: "Levothyroxine|Eltroxin|50|Tablet",
  omeprazole20: "Omeprazole|Omez|20|Capsule",
  pantoprazole40: "Pantoprazole|Pan|40|Tablet",
  domperidone10: "Domperidone|Domstal|10|Tablet",
  ors: "Oral Rehydration Salts|Jeera ORS|null|Sachet",
  vitaminC: "Vitamin C|Limcee|500|Tablet",
  multivitamin: "Multivitamin with Minerals|Zincovit|null|Tablet",
  vitaminD3: "Vitamin D3|Uprise D3|60000|Capsule",
  ironTab: "Ferrous Ascorbate|Orofer XT|100|Tablet",
  zincTab: "Zinc|Zincovit|20|Tablet",
  coughSyrup: "Cough Syrup (Antitussive)||100|Syrup",
  dmSyrup: "Dextromethorphan|Benadryl|100|Syrup",
  chlorhexidine: "Chlorhexidine|Hexidine|0.2|Mouthwash",
  clotrimazole: "Clotrimazole|Canesten|1|Cream",
  povidoneIodine: "Povidone Iodine|Betadine|10|Solution",
  dettol: "Chloroxylenol|Dettol|4.8|Liquid",
  eyeDrops: "Carboxymethylcellulose|Refresh Tears|0.5|Eye drops",
  otrivin: "Xylometazoline|Otrivin|0.1|Nasal drops",
  salbutamol: "Salbutamol|Ventolin|100|Inhaler",
  sertraline: "Sertraline||25|Tablet",
  sildenafil: "Sildenafil|Viagra|50|Tablet",
  desloratadine: "Levocetirizine||5|Tablet",
  saridon: "Aceclofenac|Hifenac|100|Tablet",
  diclofenacGel: "Diclofenac (Topical)|Voveran Gel|1|Gel",
  thermometer: "Digital Thermometer||null|Device",
  bpMonitor: "Blood Pressure Monitor||null|Device",
  gloves: "Surgical Mask||null|Device",
};

/**
 * [catalogue key, pharmacy ids, quantity each]
 *
 * The shape of the demo matters as much as the numbers: a few medicines are
 * deliberately scarce or absent network-wide so the substitution, peer-borrow
 * and "out of stock everywhere" paths have something real to work on.
 */
const INVENTORY_PLAN: [string, number[], number[]][] = [
  ["paracetamol500", [1, 2, 3, 4, 5, 6, 7, 8], [120, 80, 60, 40, 30, 50, 25, 70]],
  ["dolo650", [1, 2, 3, 4, 5, 6, 7, 8], [60, 40, 30, 20, 15, 25, 10, 35]],
  ["crocin400", [1], [0]],
  ["brufen400", [1, 2, 3, 4, 6, 8], [20, 10, 15, 5, 10, 12]],
  ["ibuprofen400", [1, 2, 3, 4], [3, 3, 3, 3]],
  ["aspirin75", [1, 3, 5, 7, 8], [40, 25, 20, 15, 30]],
  ["diclofenac50", [1, 2, 3, 4, 6, 8], [50, 35, 25, 25, 30, 20]],
  ["paracetamolPaed", [1, 2, 3], [25, 15, 20]],
  ["cetirizine10", [1, 2, 4, 6, 8], [50, 35, 25, 30, 20]],
  ["fexofenadine120", [1, 3, 6], [12, 8, 10]],
  ["montelukast10", [1, 2, 3], [2, 1, 2]],
  ["amoxicillin500", [2], [3]],
  ["azithromycin500", [1, 3], [2, 1]],
  ["ciprofloxacin500", [1, 2, 4, 6], [22, 14, 9, 12]],
  ["metformin500", [1, 2, 5], [18, 12, 10]],
  ["amlodipine5", [1, 2, 3, 5, 7], [30, 20, 18, 15, 12]],
  ["telmisartan40", [3, 5, 6], [25, 18, 14]],
  ["atorvastatin10", [1, 2, 4], [20, 16, 11]],
  ["levothyroxine50", [2, 3, 6], [12, 9, 7]],
  ["omeprazole20", [1, 2, 3, 5, 7], [45, 30, 25, 20, 15]],
  ["pantoprazole40", [1, 2, 4, 6, 8], [30, 20, 18, 22, 16]],
  ["domperidone10", [1, 3, 5], [24, 18, 14]],
  ["ors", [1, 2, 3, 4, 5, 6, 7, 8], [70, 50, 40, 30, 25, 35, 20, 45]],
  ["vitaminC", [1, 2, 3, 8], [90, 60, 40, 50]],
  ["multivitamin", [1, 2, 6], [45, 30, 25]],
  ["vitaminD3", [2, 4, 6], [20, 15, 12]],
  ["ironTab", [1, 3, 5], [18, 12, 10]],
  ["zincTab", [1, 2, 4, 8], [40, 28, 22, 30]],
  ["coughSyrup", [1, 2, 3, 5], [26, 18, 14, 10]],
  ["dmSyrup", [2, 3], [2, 2]],
  ["chlorhexidine", [1, 2, 4], [22, 16, 10]],
  ["clotrimazole", [1, 3, 5], [20, 14, 12]],
  ["povidoneIodine", [2, 4, 6], [30, 22, 18]],
  ["dettol", [1, 2, 3, 4, 5, 6, 7, 8], [60, 45, 35, 30, 25, 40, 20, 50]],
  ["eyeDrops", [1, 2, 4, 6], [15, 12, 9, 7]],
  ["otrivin", [2, 3, 5], [18, 14, 11]],
  ["salbutamol", [1, 3, 6], [9, 6, 5]],
  ["sertraline", [2, 4], [10, 8]],
  ["sildenafil", [3], [4]],
  ["desloratadine", [1, 2, 5, 7], [16, 12, 10, 8]],
  ["saridon", [1, 2, 3, 4, 5, 6, 7, 8], [35, 28, 22, 18, 14, 20, 10, 25]],
  ["diclofenacGel", [1, 2, 4], [24, 18, 15]],
  ["thermometer", [1, 2, 3, 4, 5], [12, 9, 7, 6, 5]],
  ["bpMonitor", [1, 3, 6], [4, 3, 2]],
  ["gloves", [1, 2, 3, 4, 5, 6, 7, 8], [50, 40, 30, 25, 20, 35, 15, 45]],
];

function genPassword(): string {
  // Guaranteed to satisfy the policy: 20 chars, all classes.
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const sym = "!@#$%^&*-_=+";
  const all = upper + lower + digit + sym;
  const pick = (set: string) => set[crypto.randomInt(0, set.length)];
  let out = pick(upper) + pick(lower) + pick(digit) + pick(sym);
  for (let i = 0; i < 16; i++) out += pick(all);
  return out
    .split("")
    .sort(() => crypto.randomInt(0, 3) - 1)
    .join("");
}

export interface DemoCredentials {
  email: string;
  role: string;
  password: string;
  note?: string;
  totp_secret?: string;
  totp_uri?: string;
}

export async function seedDatabase(): Promise<void> {
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString().slice(0, 10);

  for (const p of PHARMACIES) {
    const licCheck = verifyDocument(
      { type: "DRUG_LICENCE", number: p.lic, name: p.name },
      demoRegistryLookup
    );
    await queryRun(
      `INSERT INTO pharmacies (id, name, address, lat, lng, drug_licence_no, verification_status, response_score, fulfilment_count, licence_verified, licence_checked_at, licence_meta_json, razorpay_account_id, payout_account_status, payout_account_checked_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'activated', $14, $15)`,
      [
        p.id,
        p.name,
        p.address,
        p.lat,
        p.lng,
        p.lic,
        p.status,
        p.score,
        p.fulfil,
        licCheck.status,
        now,
        JSON.stringify({
          masked: licCheck.masked,
          reference: licCheck.reference,
          reasons: licCheck.reasons,
        }),
        // Seeded as activated so the payout story works on a fresh database. A
        // real pharmacy reaches this state through Razorpay's hosted
        // onboarding; a demo account that starts here cannot onboard without a
        // bank account nobody is going to type in.
        `acc_demo_pharmacy_${p.id}`,
        now,
        now,
      ]
    );
  }

  // --- catalogue -------------------------------------------------------------
  //
  // Ids are assigned from catalogue order so the demo is reproducible, and the
  // key -> id map is used by the inventory plan below.
  const catalogueIds = new Map<string, number>();
  let nextCatalogueId = 1;
  for (const m of MEDICINES) {
    // A brand alone is not enough to identify a medicine on screen: "Mox" and
    // "Azithral" say nothing about what they are. The generic and strength go in
    // parentheses so the display name is unambiguous without opening a detail.
    const genericLabel = `${m.generic} ${strengthLabel(m)}`.trim();
    const displayName = m.brand ? `${m.brand} (${genericLabel})` : genericLabel;
    const aliases = [
      m.generic,
      ...(m.ingredients ?? []),
      ...(m.brand ? [m.brand] : []),
      ...(m.aliases ?? []),
    ]
      // De-duplicated case-insensitively, order preserved.
      .filter((v, i, arr) => arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
      .join(",");

    await queryRun(
      `INSERT INTO medicines
         (id, display_name, generic_name, brand_name, ingredients, strength_value, strength_unit,
          dosage_form, route, category, subcategory, therapeutic_class, manufacturer,
          requires_prescription, rx_basis, regulatory_status, verification_status,
          source, source_ref, package_size, barcode, aliases, description,
          price_paise, is_active, name, salt, rx_required, synonyms, strength, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,1,$25,$26,$27,$28,$29,$30,$30)
       ON CONFLICT (id) DO NOTHING`,
      [
        nextCatalogueId,
        displayName,
        m.generic,
        m.brand ?? null,
        (m.ingredients ?? []).join(", ") || null,
        m.strengthValue ?? null,
        m.strengthUnit ?? null,
        m.form,
        m.route ?? null,
        m.category,
        m.subcategory ?? null,
        m.therapeuticClass ?? null,
        m.manufacturer ?? null,
        m.rx ? 1 : 0,
        // How the flag was arrived at. Never "ai": the prescription status is
        // curated knowledge, and the provenance has to say so.
        "curated",
        m.rx ? "prescription" : "otc",
        m.verification ?? "unverified",
        m.verification === "demo" ? "demo-fixture" : "curated-demo",
        m.sourceRef ?? null,
        m.packageSize ?? null,
        null, // barcode: never invented
        aliases,
        null, // description: no clinical claims written by hand
        m.pricePaise,
        displayName,
        m.generic,
        m.rx ? 1 : 0,
        aliases,
        strengthLabel(m),
        now,
      ]
    );
    const naturalKey = `${m.generic}|${m.brand ?? ""}|${m.strengthValue ?? "null"}|${m.form}`;
    catalogueIds.set(naturalKey, nextCatalogueId);
    // Also indexed brand-first. The stock plan is written by humans, who think
    // in brands; without this, every brand-led key fails for a reason that has
    // nothing to do with the data.
    if (m.brand) {
      catalogueIds.set(
        `${m.brand}|${m.generic}|${m.strengthValue ?? "null"}|${m.form}`,
        nextCatalogueId
      );
    }
    priceLookup = new Map(priceLookup).set(nextCatalogueId, m.pricePaise);
    nextCatalogueId++;
  }

  /**
   * Resolves a stock plan key to a catalogue row.
   *
   * Refuses loudly rather than guessing. A typo here would otherwise leave the
   * demo quietly missing a medicine that the walkthrough talks about.
   */
  function idForKey(key: string): number {
    const spec = STOCKED[key];
    if (!spec) throw new Error(`Unknown catalogue key in the stock plan: ${key}`);
    const [generic, brand, strength, form] = spec.split("|");
    const id = catalogueIds.get(`${generic}|${brand}|${strength}|${form}`);
    if (!id) {
      throw new Error(`Catalogue key "${key}" does not resolve: no entry matches ${spec}`);
    }
    return id;
  }

  for (const [key, pharmacyIds, quantities] of INVENTORY_PLAN) {
    const medicineId = idForKey(key);
    for (const [i, pid] of pharmacyIds.entries()) {
      const qty = quantities[i] ?? 0;
      if (qty <= 0) continue;
      // Awaited in a loop, deliberately. A fire-and-forget insert races the next
      // one and trips the primary key on (pharmacy_id, medicine_id).
      await queryRun(
        `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked, expiry_date,
                                price_paise, batch_no, last_verified_at, updated_at)
         VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $7)
         ON CONFLICT (pharmacy_id, medicine_id) DO NOTHING`,
        [pid, medicineId, qty, expiry, pharmacyPriceFor(pid, medicineId), `DEMO-${medicineId}-A`, now]
      );
    }
  }

  const credentials: DemoCredentials[] = [];
  async function addUser(u: {
    email: string;
    name: string;
    phone?: string;
    role: string;
    pharmacy_id?: number;
    totp?: boolean;
    vehicle?: string;
    idType?: string;
    idNumber?: string;
    online?: number;
    partnerStatus?: string;
    rating?: number;
    note?: string;
  }) {
    const password = genPassword();
    let idLast4: string | null = null;
    let idNumberEnc: string | null = null;
    let docStatus: string | null = null;
    let docCheckedAt: string | null = null;
    let docMetaJson: string | null = null;
    if (u.idType && u.idNumber) {
      const kind = parseDocumentKind(u.idType);
      const check = verifyDocument(
        { type: u.idType, number: u.idNumber, name: u.name },
        demoRegistryLookup
      );
      idLast4 = normalizeDocument(kind, u.idNumber).slice(-4);
      idNumberEnc = encryptSecret(check.normalized);
      docStatus = check.status;
      docCheckedAt = now;
      docMetaJson = JSON.stringify({
        masked: check.masked,
        reference: check.reference,
        checksumValid: check.checksumValid,
        reasons: check.reasons,
      });
    }
    const inserted = await queryReturning<{ id: number }>(
      `INSERT INTO users (email, name, phone, password_hash, role, pharmacy_id, totp_secret_enc, totp_enabled,
         vehicle_number, id_type, id_last4, id_number_enc, doc_status, doc_checked_at, doc_meta_json,
         partner_online, partner_status, rating, razorpay_account_id, payout_account_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING id`,
      [
        u.email,
        u.name,
        u.phone ?? null,
        hashPasswordSync(password),
        u.role,
        u.pharmacy_id ?? null,
        null,
        0,
        u.vehicle ?? null,
        u.idType ?? null,
        idLast4,
        idNumberEnc,
        docStatus,
        docCheckedAt,
        docMetaJson,
        u.online ?? 0,
        u.partnerStatus ?? null,
        u.rating ?? 4.8,
        // Riders get a linked payout account exactly as pharmacy owners do —
        // without one their delivery fee could never be paid out, and the
        // earnings screen would have nothing truthful to show.
        u.role === "delivery_partner" ? `acc_demo_rider_${u.email}` : null,
        u.role === "delivery_partner" ? "activated" : null,
        now,
      ]
    );
    const userId = inserted!.id;
    let totpSecret: string | undefined;
    let totpUriStr: string | undefined;
    if (u.totp) {
      totpSecret = generateTotpSecret();
      await queryRun(
        "UPDATE users SET totp_secret_enc = $1, totp_enabled = 1 WHERE id = $2",
        [encryptSecret(totpSecret), userId]
      );
      totpUriStr = totpUri(totpSecret, u.email);
      for (let i = 0; i < 10; i++) {
        await queryRun(
          "INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)",
          [userId, hashPasswordSync(crypto.randomBytes(9).toString("base64url"))]
        );
      }
    }
    credentials.push({
      email: u.email,
      role: u.role,
      password,
      note: u.note,
      totp_secret: totpSecret,
      totp_uri: totpUriStr,
    });
    return userId;
  }

  // Admin (2FA mandatory, enforced in code).
  await addUser({
    email: "admin@medimesh.demo",
    name: "Demo Admin",
    role: "admin",
    totp: true,
    note: "2FA required for admin",
  });

  // Pharmacy owners (all owners have 2FA enabled for the demo).
  for (const p of PHARMACIES) {
    await addUser({
      email: `owner${p.id}@medimesh.demo`,
      name: `${p.name} Owner`,
      phone: `90000000${String(p.id).padStart(2, "0")}`,
      role: "pharmacy_owner",
      pharmacy_id: p.id,
      totp: true,
      note: p.status === "pending" ? "Pharmacy pending admin verification" : undefined,
    });
  }
  await addUser({
    email: "staff1@medimesh.demo",
    name: "Apollo Staff (Demo)",
    role: "pharmacy_staff",
    pharmacy_id: 1,
  });

  // Customers
  await addUser({ email: "customer1@medimesh.demo", name: "Asha Demo", phone: "9811100001", role: "customer" });
  await addUser({ email: "customer2@medimesh.demo", name: "Ravi Demo", phone: "9811100002", role: "customer" });
  await addUser({ email: "customer3@medimesh.demo", name: "Meera Demo", phone: "9811100003", role: "customer" });

  // Delivery partners
  const demoAadhaarBase = "23456789012";
  const demoAadhaar = demoAadhaarBase + verhoeffCheckDigit(demoAadhaarBase);
  await addUser({ email: "rider1@medimesh.demo", name: "Kiran Demo", phone: "9722200001", role: "delivery_partner", vehicle: "KA-01-DEMO-1111", idType: "DL", idNumber: "KA0120180004821", online: 1, partnerStatus: "verified", rating: 4.9, note: "Approved partner" });
  await addUser({ email: "rider2@medimesh.demo", name: "Sana Demo", phone: "9722200002", role: "delivery_partner", vehicle: "KA-02-DEMO-2222", idType: "Aadhaar", idNumber: demoAadhaar, online: 1, partnerStatus: "verified", rating: 4.7, note: "Approved partner (Aadhaar verified)" });
  await addUser({ email: "rider3@medimesh.demo", name: "Vikram Demo", phone: "9722200003", role: "delivery_partner", vehicle: "KA-03-DEMO-3333", idType: "DL", idNumber: "KA0120190001177", online: 0, partnerStatus: "verified", rating: 4.6 });
  await addUser({ email: "rider4@medimesh.demo", name: "Neha Demo", phone: "9722200004", role: "delivery_partner", vehicle: "KA-04-DEMO-4444", idType: "DL", idNumber: "KA0120200005566", online: 0, partnerStatus: "verified", rating: 4.5, note: "Auto-approved partner" });

  // Explicit-id inserts left the sequences behind; realign them.
  await queryRaw(`
    SELECT setval(pg_get_serial_sequence('pharmacies','id'), GREATEST((SELECT MAX(id) FROM pharmacies), 1));
    SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT MAX(id) FROM users), 1));
    SELECT setval(pg_get_serial_sequence('medicines','id'), GREATEST((SELECT MAX(id) FROM medicines), 1));
  `);

  await queryRun(
    "INSERT INTO settings (key, value) VALUES ('lock_seconds', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [String(defaultLockSeconds())]
  );
  await queryRun(
    "INSERT INTO settings (key, value) VALUES ('demo_outbreak', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  );

  writeCredentials(credentials);
  printCredentials(credentials);
}

export function defaultLockSeconds(): number {
  const minutes = Number(process.env.LOCK_MINUTES || 30);
  return Math.max(1, Math.round(minutes * 60));
}

function writeCredentials(creds: DemoCredentials[]) {
  const file = path.join(dataDir(), ".demo-credentials.txt");
  const lines = [
    "# MediMesh demo credentials — AUTO-GENERATED — DO NOT COMMIT",
    "# Passwords are random per seed run. Regenerated on every Reset demo.",
    "",
  ];
  for (const c of creds) {
    lines.push(`${c.role.padEnd(18)} ${c.email}`);
    lines.push(`  password: ${c.password}`);
    if (c.totp_secret) {
      lines.push(`  TOTP secret: ${c.totp_secret}`);
      lines.push(`  TOTP URI:    ${c.totp_uri}`);
    }
    if (c.note) lines.push(`  note: ${c.note}`);
    lines.push("");
  }
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
}

function printCredentials(creds: DemoCredentials[]) {
  if (process.env.MM_QUIET === "1") return;
  const lines = [
    "",
    "============================================================",
    " MediMesh demo credentials (generated, also in .demo-credentials.txt)",
    "============================================================",
  ];
  for (const c of creds) {
    lines.push(`${c.role.padEnd(18)} ${c.email.padEnd(28)} ${c.password}`);
    if (c.totp_secret) lines.push(`   ^ 2FA secret: ${c.totp_secret}`);
  }
  lines.push("============================================================");
  lines.push("");
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}
