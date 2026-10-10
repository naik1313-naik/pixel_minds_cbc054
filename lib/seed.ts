import type Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { hashPasswordSync } from "./password";
import { encryptSecret, generateTotpSecret, totpUri } from "./crypto";
import { dataDir } from "./paths";
import {
  verifyDocument,
  demoRegistryLookup,
  parseDocumentKind,
  normalizeDocument,
  verhoeffCheckDigit,
} from "./identity";

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

// 24 medicines, 3 rx_required. Prices in paise.
const MEDICINES = [
  { id: 1, name: "Paracetamol 500mg", salt: "Acetaminophen", paise: 250, rx: 0 },
  { id: 2, name: "Dolo 650", salt: "Acetaminophen", paise: 350, rx: 0 },
  { id: 3, name: "Crocin Advance", salt: "Acetaminophen", paise: 300, rx: 0 },
  { id: 4, name: "Ibuprofen 400mg", salt: "Ibuprofen", paise: 400, rx: 0 },
  { id: 5, name: "Brufen 400", salt: "Ibuprofen", paise: 450, rx: 0 },
  { id: 6, name: "Aspirin 75mg", salt: "Acetylsalicylic Acid", paise: 200, rx: 0 },
  { id: 7, name: "Cetirizine 10mg", salt: "Cetirizine", paise: 300, rx: 0 },
  { id: 8, name: "Allegra 120", salt: "Fexofenadine", paise: 600, rx: 0 },
  { id: 9, name: "Amoxicillin 500mg", salt: "Amoxicillin", paise: 800, rx: 1 },
  { id: 10, name: "Azithromycin 500", salt: "Azithromycin", paise: 2200, rx: 1 },
  { id: 11, name: "Metformin 500mg", salt: "Metformin HCl", paise: 350, rx: 0 },
  { id: 12, name: "Amlodipine 5mg", salt: "Amlodipine", paise: 400, rx: 1 },
  { id: 13, name: "Vitamin C 500", salt: "Ascorbic Acid", paise: 500, rx: 0 },
  { id: 14, name: "Zincovit", salt: "Zinc + Multivitamin", paise: 600, rx: 0 },
  { id: 15, name: "ORS Sachet", salt: "Oral Rehydration Salts", paise: 1000, rx: 0 },
  { id: 16, name: "Omeprazole 20", salt: "Omeprazole", paise: 600, rx: 0 },
  { id: 17, name: "Domperidone 10", salt: "Domperidone", paise: 500, rx: 0 },
  { id: 18, name: "Ranitidine 150", salt: "Ranitidine", paise: 400, rx: 0 },
  { id: 19, name: "Cough Syrup 100ml", salt: "Dextromethorphan", paise: 9000, rx: 0 },
  { id: 20, name: "Diclofenac Gel 30g", salt: "Diclofenac", paise: 7500, rx: 0 },
  { id: 21, name: "Pantoprazole 40", salt: "Pantoprazole", paise: 700, rx: 0 },
  { id: 22, name: "Montelukast 10", salt: "Montelukast", paise: 1200, rx: 1 },
  { id: 23, name: "Cough Drops", salt: "Menthol", paise: 3000, rx: 0 },
  { id: 24, name: "Antiseptic Liquid", salt: "Chloroxylenol", paise: 11000, rx: 0 },
];

// [pharmacy_id, medicine_id, qty_total]
// 4 medicines with 2-5 units network-wide: #20 (2), #10 (3), #19 (4), #17 (5)
// 1 out everywhere: #3 (Crocin Advance)
// shared salts: Acetaminophen (#1,#2,#3), Ibuprofen (#4,#5)
const INVENTORY: [number, number, number][] = [
  [1, 1, 120], [2, 1, 80], [3, 1, 60], [4, 1, 40], [5, 1, 30], [6, 1, 50], [7, 1, 25], [8, 1, 70],
  [1, 2, 60], [2, 2, 40], [3, 2, 30], [4, 2, 20], [5, 2, 15], [6, 2, 25], [7, 2, 10], [8, 2, 35],
  [1, 4, 3], [2, 4, 3], [3, 4, 3], [4, 4, 3],
  [1, 5, 20], [2, 5, 10], [3, 5, 15], [4, 5, 5], [6, 5, 10], [8, 5, 12],
  [1, 6, 40], [3, 6, 25], [5, 6, 20], [7, 6, 15], [8, 6, 30],
  [1, 7, 50], [2, 7, 35], [4, 7, 25], [6, 7, 30], [8, 7, 20],
  [1, 8, 12], [3, 8, 8], [6, 8, 10],
  [1, 9, 2], [2, 9, 1], [3, 9, 2],
  [2, 10, 3],
  [1, 11, 25], [4, 11, 20], [7, 11, 15],
  [1, 12, 18], [2, 12, 12], [5, 12, 10],
  [1, 13, 90], [2, 13, 60], [3, 13, 40], [8, 13, 50],
  [1, 14, 45], [2, 14, 30], [6, 14, 25],
  [1, 15, 70], [3, 15, 50], [5, 15, 40], [7, 15, 30],
  [1, 16, 30], [2, 16, 20], [4, 16, 18], [6, 16, 22],
  [1, 17, 2], [2, 17, 2], [3, 17, 1],
  [1, 18, 15], [2, 18, 10], [5, 18, 8],
  [2, 19, 4],
  [2, 20, 1], [3, 20, 1],
  [1, 21, 22], [2, 21, 14], [5, 21, 9],
  [1, 22, 16], [3, 22, 11], [6, 22, 7],
  [1, 23, 60], [2, 23, 40], [8, 23, 30],
  [1, 24, 35], [4, 24, 20], [6, 24, 15],
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

export function seedAll(db: Database.Database) {
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString().slice(0, 10);

  const insPharmacy = db.prepare(
    `INSERT INTO pharmacies (id, name, address, lat, lng, drug_licence_no, verification_status, response_score, fulfilment_count, licence_verified, licence_checked_at, licence_meta_json, created_at)
     VALUES (@id, @name, @address, @lat, @lng, @drug_licence_no, @verification_status, @response_score, @fulfilment_count, @licence_verified, @licence_checked_at, @licence_meta_json, @created_at)`
  );
  for (const p of PHARMACIES) {
    const licCheck = verifyDocument(
      { type: "DRUG_LICENCE", number: p.lic, name: p.name },
      demoRegistryLookup
    );
    insPharmacy.run({
      id: p.id,
      name: p.name,
      address: p.address,
      lat: p.lat,
      lng: p.lng,
      drug_licence_no: p.lic,
      verification_status: p.status,
      response_score: p.score,
      fulfilment_count: p.fulfil,
      licence_verified: licCheck.status,
      licence_checked_at: now,
      licence_meta_json: JSON.stringify({
        masked: licCheck.masked,
        reference: licCheck.reference,
        reasons: licCheck.reasons,
      }),
      created_at: now,
    });
  }

  const insMed = db.prepare(
    "INSERT INTO medicines (id, name, salt, price_paise, rx_required) VALUES (?, ?, ?, ?, ?)"
  );
  for (const m of MEDICINES) insMed.run(m.id, m.name, m.salt, m.paise, m.rx);

  const insInv = db.prepare(
    "INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked, expiry_date) VALUES (?, ?, ?, 0, ?)"
  );
  for (const [pid, mid, qty] of INVENTORY) insInv.run(pid, mid, qty, expiry);

  const credentials: DemoCredentials[] = [];
  const insUser = db.prepare(
    `INSERT INTO users (email, name, phone, password_hash, role, pharmacy_id, totp_secret_enc, totp_enabled,
       vehicle_number, id_type, id_last4, id_number_enc, doc_status, doc_checked_at, doc_meta_json,
       partner_online, partner_status, rating, created_at)
     VALUES (@email, @name, @phone, @password_hash, @role, @pharmacy_id, @totp_secret_enc, @totp_enabled,
       @vehicle_number, @id_type, @id_last4, @id_number_enc, @doc_status, @doc_checked_at, @doc_meta_json,
       @partner_online, @partner_status, @rating, @created_at)`
  );
  const insCode = db.prepare(
    "INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)"
  );

  function addUser(u: {
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
    const info = insUser.run({
      email: u.email,
      name: u.name,
      phone: u.phone ?? null,
      password_hash: hashPasswordSync(password),
      role: u.role,
      pharmacy_id: u.pharmacy_id ?? null,
      totp_secret_enc: null,
      totp_enabled: 0,
      vehicle_number: u.vehicle ?? null,
      id_type: u.idType ?? null,
      id_last4: idLast4,
      id_number_enc: idNumberEnc,
      doc_status: docStatus,
      doc_checked_at: docCheckedAt,
      doc_meta_json: docMetaJson,
      partner_online: u.online ?? 0,
      partner_status: u.partnerStatus ?? null,
      rating: u.rating ?? 4.8,
      created_at: now,
    });
    const userId = Number(info.lastInsertRowid);
    let totpSecret: string | undefined;
    let totpUriStr: string | undefined;
    if (u.totp) {
      totpSecret = generateTotpSecret();
      db.prepare(
        "UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?"
      ).run(encryptSecret(totpSecret), userId);
      totpUriStr = totpUri(totpSecret, u.email);
      for (let i = 0; i < 10; i++) {
        insCode.run(userId, hashPasswordSync(crypto.randomBytes(9).toString("base64url")));
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
  addUser({
    email: "admin@medimesh.demo",
    name: "Demo Admin",
    role: "admin",
    totp: true,
    note: "2FA required for admin",
  });

  // Pharmacy owners (all owners have 2FA enabled for the demo).
  for (const p of PHARMACIES) {
    addUser({
      email: `owner${p.id}@medimesh.demo`,
      name: `${p.name} Owner`,
      phone: `90000000${String(p.id).padStart(2, "0")}`,
      role: "pharmacy_owner",
      pharmacy_id: p.id,
      totp: true,
      note: p.status === "pending" ? "Pharmacy pending admin verification" : undefined,
    });
  }
  addUser({
    email: "staff1@medimesh.demo",
    name: "Apollo Staff (Demo)",
    role: "pharmacy_staff",
    pharmacy_id: 1,
  });

  // Customers
  addUser({ email: "customer1@medimesh.demo", name: "Asha Demo", phone: "9811100001", role: "customer" });
  addUser({ email: "customer2@medimesh.demo", name: "Ravi Demo", phone: "9811100002", role: "customer" });
  addUser({ email: "customer3@medimesh.demo", name: "Meera Demo", phone: "9811100003", role: "customer" });

  // Delivery partners (one pending for admin demo)
  const demoAadhaarBase = "23456789012";
  const demoAadhaar = demoAadhaarBase + verhoeffCheckDigit(demoAadhaarBase);
  addUser({ email: "rider1@medimesh.demo", name: "Kiran Demo", phone: "9722200001", role: "delivery_partner", vehicle: "KA-01-DEMO-1111", idType: "DL", idNumber: "KA0120180004821", online: 1, partnerStatus: "verified", rating: 4.9, note: "Approved partner" });
  addUser({ email: "rider2@medimesh.demo", name: "Sana Demo", phone: "9722200002", role: "delivery_partner", vehicle: "KA-02-DEMO-2222", idType: "Aadhaar", idNumber: demoAadhaar, online: 1, partnerStatus: "verified", rating: 4.7, note: "Approved partner (Aadhaar verified)" });
  addUser({ email: "rider3@medimesh.demo", name: "Vikram Demo", phone: "9722200003", role: "delivery_partner", vehicle: "KA-03-DEMO-3333", idType: "DL", idNumber: "KA0120190001177", online: 0, partnerStatus: "verified", rating: 4.6 });
  addUser({ email: "rider4@medimesh.demo", name: "Neha Demo", phone: "9722200004", role: "delivery_partner", vehicle: "KA-04-DEMO-4444", idType: "DL", idNumber: "KA0120200005566", online: 0, partnerStatus: "verified", rating: 4.5, note: "Auto-approved partner" });

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('lock_seconds', ?)").run(
    String(defaultLockSeconds())
  );
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_outbreak', '0')").run();

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
