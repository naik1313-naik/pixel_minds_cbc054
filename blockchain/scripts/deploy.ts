/**
 * Deploys MediMeshLedger to the local Hardhat network and writes
 * deployments/local.json so the Next.js server can read the address + ABI
 * without compiling Solidity.
 *
 *   npm run node          # terminal 1
 *   npm run deploy        # terminal 2
 *
 * The local demo maps each application pharmacy to a deterministic dev wallet
 * (hardhat account #N). Those keys are public and must never be funded or
 * reused outside a local chain.
 */
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log(`Deploying to chainId ${chainId} as ${deployer.address}`);

  const Factory = await ethers.getContractFactory("MediMeshLedger");
  const ledger = await Factory.deploy(deployer.address);
  await ledger.waitForDeployment();
  const address = await ledger.getAddress();

  // Deterministic demo mapping: hardhat account index -> pharmacy id.
  // Pharmacy ids 1..8 in the seeded demo data line up with accounts 1..8.
  const signers = await ethers.getSigners();
  const adminAddress = await ledger.getAddress();
  const pharmacyWallets: Record<string, string> = {};
  const deliveryWallets: Record<string, string> = {};

  // Accounts 1..8 act as pharmacy wallets; accounts 11..13 as delivery actors.
  // The application resolves a pharmacy's wallet by its pharmacy_id.
  for (let i = 1; i <= 8; i++) {
    if (signers[i]) pharmacyWallets[String(i)] = await signers[i].getAddress();
  }
  for (let i = 11; i <= 13; i++) {
    if (signers[i]) deliveryWallets[String(i)] = await signers[i].getAddress();
  }

  console.log("Authorizing demo pharmacy wallets...");
  for (const wallet of Object.values(pharmacyWallets)) {
    const tx = await ledger.authorizePharmacy(wallet);
    await tx.wait();
  }

  console.log("Authorizing demo delivery wallets...");
  for (const wallet of Object.values(deliveryWallets)) {
    const tx = await ledger.authorizeDeliveryActor(wallet);
    await tx.wait();
  }

  const deploymentTx = ledger.deploymentTransaction();
  const deploymentReceipt = deploymentTx
    ? await ethers.provider.getTransactionReceipt(deploymentTx.hash)
    : null;

  const abi = (await import("../artifacts/contracts/MediMeshLedger.sol/MediMeshLedger.json")).default.abi;

  // Local demo keystore.
  //
  // Each pharmacy/delivery wallet needs a real key because the contract enforces
  // roles per address. When connecting to a running node the signers arrive over
  // JSON-RPC and expose no private key, so we re-derive them from Hardhat's
  // PUBLIC default mnemonic — the exact accounts `npx hardhat node` prints.
  //
  // These keys are deliberately public and hold nothing. They must never be
  // funded and never reused on a public or production network. The Next.js
  // server refuses to read them when NODE_ENV=production
  // (see lib/blockchain/client.ts getSignerFor).
  const HARDHAT_MNEMONIC =
    process.env.MM_HARDHAT_MNEMONIC ??
    "test test test test test test test test test test test junk";
  const HD_PATH_BASE = "m/44'/60'/0'/0";
  const devKeys: {
    admin: string;
    pharmacies: Record<string, string>;
    delivery: Record<string, string>;
  } = { admin: "", pharmacies: {}, delivery: {} };

  for (let i = 0; i < 20; i++) {
    const node = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `${HD_PATH_BASE}/${i}`);
    if (node.address !== (await signers[i]?.getAddress())) {
      throw new Error(
        `Derived key ${i} (${node.address}) does not match the node's account ${i}. ` +
          `The node is running with a different mnemonic.`
      );
    }
    if (i === 0) devKeys.admin = node.privateKey;
    else if (i >= 1 && i <= 8) devKeys.pharmacies[String(i)] = node.privateKey;
    else if (i >= 11 && i <= 13) devKeys.delivery[String(i)] = node.privateKey;
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const payload = {
    network: {
      name: network.name === "unknown" ? "localhost" : network.name,
      chainId,
      rpcUrl: "http://127.0.0.1:8545",
    },
    contract: {
      name: "MediMeshLedger",
      address,
      deploymentTxHash: deploymentReceipt?.hash ?? null,
      blockNumber: deploymentReceipt?.blockNumber ?? null,
    },
    accounts: {
      // Never a real key — these are hardhat's public dev keys.
      admin: deployer.address,
      pharmacies: pharmacyWallets,
      delivery: deliveryWallets,
    },
    devKeys,
    abi,
    deployedAt: new Date().toISOString(),
  };

  const outFile = path.join(deploymentsDir, "local.json");
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  console.log(`\nMediMeshLedger deployed: ${address}`);
  console.log(`Admin: ${deployer.address}`);
  console.log(`Pharmacy wallets: ${Object.keys(pharmacyWallets).length}`);
  console.log(`Delivery wallets: ${Object.keys(deliveryWallets).length}`);
  console.log(`Wrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
