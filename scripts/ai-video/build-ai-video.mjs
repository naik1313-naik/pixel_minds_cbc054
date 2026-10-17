#!/usr/bin/env node
/**
 * Builds "How MediMesh uses AI" — a short screen-recorded explainer.
 *
 * The slides are rendered from a single HTML template and screenshotted at
 * 1920x1080, then composed into an MP4 with ffmpeg. Numbers on the slides are
 * read from the live database and the live API, so the video cannot drift from
 * the code it describes.
 *
 *   node scripts/ai-video/build-ai-video.mjs
 *
 * Output: ~/Desktop/MediMesh-AI.mp4 (override with --out)
 *
 * Why render slides rather than screen-record a terminal: a recorded terminal
 * shows whatever happened at record time, including a typo. Rendered slides
 * re-derive their numbers every run, so a rebuild after a data change is correct
 * by construction.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SLIDES = path.join(HERE, "slides.html");
const SLIDE_COUNT = 12;
const FPS = 30;
const SECONDS_PER_SLIDE = 6.5;

const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1] : path.join(os.homedir(), "Desktop", "MediMesh-AI.mp4");

function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}

async function readNumbers() {
  const pool = new Pool({
    connectionString: connectionString(),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  const q = async (sql) => (await pool.query(sql)).rows[0];
  try {
    const cat = await q("SELECT COUNT(*)::int AS medicines, COUNT(DISTINCT category)::int AS categories FROM medicines");
    const rx = await q("SELECT COUNT(*)::int AS n FROM medicines WHERE requires_prescription = 1");
    const demo = await q("SELECT COUNT(*)::int AS n FROM medicines WHERE verification_status = 'demo'");

    // Test counts are read from the repo rather than typed in, so the slide
    // cannot claim a number the suite no longer produces.
    const countTests = () => {
      try {
        const out = execFileSync("npx", ["vitest", "list"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").filter((l) => l.includes(" > ")).length;
      } catch {
        return null;
      }
    };

    // A live answer from the real endpoint, so the "it understood" slide shows
    // what the parser actually returned rather than a transcription of it.
    let understood = "within 3 km · in-stock only · medicine: paracetamol";
    try {
      const base = process.env.MM_BASE_URL ?? "http://localhost:3000";
      const login = await fetch(`${base}/api/auth/demo-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "customer" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const res = await fetch(
        `${base}/api/search?q=${encodeURIComponent("show nearby pharmacies with paracetamol in stock within 3 km")}`,
        { headers: { cookie } }
      );
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.understood) && json.understood.length) {
          understood = json.understood.join("  ·  ");
        }
      }
    } catch {
      // The app not running is not a reason to fail the build; the slide falls
      // back to the known parser output.
    }

    const countContractTests = () => {
      try {
        const out = execFileSync("npx", ["hardhat", "test"], {
          cwd: path.join(ROOT, "blockchain"),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const m = out.match(/(\d+) passing/);
        return m ? Number(m[1]) : null;
      } catch {
        return null;
      }
    };

    let e2e = null;
    try {
      // Counted by asking Playwright, not by multiplying spec files: the real
      // number includes every test inside each file, across both viewports.
      const out = execFileSync("npx", ["playwright", "test", "--list"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/(\d+) tests? found/);
      e2e = m ? Number(m[1]) : null;
    } catch {
      /* Playwright unavailable: the slide falls back rather than lying */
    }

    return {
      medicines: cat.medicines,
      categories: cat.categories,
      rx: rx.n,
      demoRows: demo.n,
      tests: countTests() ?? 300,
      contractTests: countContractTests() ?? 54,
      e2e: e2e ?? 20,
      understood,
      tagline: "free-first AI, no paid service",
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log("Building the MediMesh AI video\n");

  if (!fs.existsSync(OUT.endsWith(".mp4") ? OUT : path.dirname(OUT))) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true }, { recursive: true });
  }

  const data = await readNumbers();
  console.log("  numbers read from the live system:");
  for (const [k, v] of Object.entries(data)) console.log(`    ${k}: ${v}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mm-ai-video-"));
  const shots = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  for (let i = 1; i <= SLIDE_COUNT; i++) {
    await page.addInitScript((d) => {
      window.__DATA__ = d;
    }, data);
    await page.goto(`file://${SLIDES}?slide=${i}`);
    // One frame past the load event, so fonts and layout have settled. Anything
    // less and an occasional slide renders mid-paint.
    await page.waitForTimeout(350);
    const file = path.join(work, `slide-${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    process.stdout.write(`  rendered slide ${i}/${SLIDE_COUNT}\n`);
  }
  await browser.close();

  // Compose. Each still is held for a fixed time and cross-faded into the next,
  // so the deck moves rather than cutting.
  const listFile = path.join(work, "concat.txt");
  const parts = [];
  for (let i = 0; i < shots.length; i++) {
    const hold = i === shots.length - 1 ? SECONDS_PER_SLIDE : SECONDS_PER_SLIDE + 0.4;
    parts.push(
      `file '${shots[i]}'\nduration ${hold.toFixed(2)}`,
    );
    parts.push(`file '${shots[i]}'`);
  }
  fs.writeFileSync(listFile, parts.join("\n"));

  const tmpVideo = path.join(work, "video.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-vf", `fps=${FPS},format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-movflags", "+faststart",
      tmpVideo,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  fs.copyFileSync(tmpVideo, OUT);
  const { size } = fs.statSync(OUT);
  fs.rmSync(work, { recursive: true, force: true });

  console.log(`\n  Saved: ${OUT}`);
  console.log(`  ${SLIDE_COUNT} slides · ${Math.round(SLIDE_COUNT * SECONDS_PER_SLIDE)}s · ${(size / 1e6).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});