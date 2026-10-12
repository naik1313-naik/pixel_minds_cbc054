/**
 * Regenerates lib/blockchain/abi.generated.json from the compiled Hardhat
 * artifact so the Next.js server never reads the artifacts directory at
 * runtime and never compiles Solidity.
 *
 *   node scripts/generate-abi.mjs
 *
 * Run this after `npm run compile` in blockchain/.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(
  root,
  "blockchain",
  "artifacts",
  "contracts",
  "MediMeshLedger.sol",
  "MediMeshLedger.json"
);
const out = path.join(root, "lib", "blockchain", "abi.generated.json");

if (!fs.existsSync(artifact)) {
  console.error(`Artifact not found at ${artifact}`);
  console.error("Run: cd blockchain && npm run compile");
  process.exit(1);
}

const { abi } = JSON.parse(fs.readFileSync(artifact, "utf8"));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(abi, null, 2) + "\n");
console.log(`Wrote ${out} (${abi.length} ABI entries)`);
