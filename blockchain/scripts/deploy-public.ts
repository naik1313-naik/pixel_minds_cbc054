/**
 * Deploys MediMeshLedger to a public testnet and records the address + ABI in
 * deployments/<name>.json, so the Next.js server can point at a chain other
 * than a laptop.
 *
 *   BASE_SEPOLIA_RPC_URL=https://...  \
 *   MM_DEPLOYER_PRIVATE_KEY=0x...     \
 *   npx hardhat run scripts/deploy-public.ts --network baseSepolia
 *
 * Deliberately refuses to do several things the local script does:
 *
 *   - it writes NO private keys to disk. The local script derives Hardhat's
 *     public dev keys because it has to sign as a dozen demo pharmacies; on a
 *     public network those accounts are real, funded accounts, and their keys
 *     do not belong in a JSON file in a repository.
 *   - it will not deploy from the Hardhat default mnemonic. Those keys are
 *     printed on every Hardhat install on the internet.
 *   - it will not run without an explicit acknowledgement, so an accidental
 *     invocation cannot spend real (test) funds or leave a contract behind that
 *     nobody meant to create.
 *
 * Pharmacy wallets on a public chain are still a real problem this script does
 * not pretend to solve: the ledger checks PHARMACY_ROLE per address, so each
 * pharmacy must sign its own settlements from its own wallet. Authorize them
 * with `authorizePharmacy` as they onboard.
 */
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/** Hardhat's public default mnemonic. Rejected outright, on any network. */
const PUBLIC_DEV_PHRASE = "test test test test test test test test test test test junk";

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    throw new Error(
      `Refusing to run against ${network.name}. Use scripts/deploy.ts for the local demo chain.`
    );
  }

  const key = process.env.MM_DEPLOYER_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      "MM_DEPLOYER_PRIVATE_KEY is not set. Export the deployer key for this testnet."
    );
  }

  const wallet = new ethers.Wallet(key);
  // `Wallet` does not expose the phrase it came from, so the check is done by
  // deriving the addresses the public dev mnemonic produces and comparing.
  for (let i = 0; i < 20; i++) {
    const node = ethers.HDNodeWallet.fromPhrase(
      PUBLIC_DEV_PHRASE,
      undefined,
      `m/44'/60'/0'/0/${i}`
    );
    if (node.address === wallet.address) {
      throw new Error(
        `Refusing to deploy from Hardhat's default dev account #${i} (${wallet.address}). ` +
          "Those keys are printed by every Hardhat install on the internet and hold nothing; " +
          "anyone can drain them. Use a funded testnet key."
      );
    }
  }
  const expected = process.env.MM_EXPECT_DEPLOYER;
  if (expected && expected.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `MM_EXPECT_DEPLOYER is ${expected} but the key resolves to ${wallet.address}. Refusing to continue.`
    );
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
  const onchain = await ethers.provider.getNetwork();
  const chainId = Number(onchain.chainId);
  const balance = await ethers.provider.getBalance(wallet.address);
  if (balance === 0n) {
    throw new Error(
      `${wallet.address} has no ${nativeSymbol(chainId)} on chain ${chainId}. Fund it from the ` +
        `faucet before deploying — deployment needs gas.`
    );
  }

  console.log(`Network: ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ${nativeSymbol(chainId)}`);

  if (process.env.MM_CONFIRM_PUBLIC_DEPLOY !== "yes") {
    throw new Error(
      "Set MM_CONFIRM_PUBLIC_DEPLOY=yes to deploy. This submits a real transaction."
    );
  }

  const Factory = await ethers.getContractFactory("MediMeshLedger", wallet);
  const ledger = await Factory.deploy(wallet.address);
  await ledger.waitForDeployment();
  const address = await ledger.getAddress();

  const deploymentTx = ledger.deploymentTransaction();
  const receipt = deploymentTx
    ? await ethers.provider.getTransactionReceipt(deploymentTx.hash)
    : null;

  const abi = (
    await import("../artifacts/contracts/MediMeshLedger.sol/MediMeshLedger.json")
  ).default.abi;

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const outFile = path.join(deploymentsDir, `${network.name}.json`);

  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: { name: network.name, chainId, rpcUrl: rpcUrl ?? null },
        contract: {
          name: "MediMeshLedger",
          address,
          deploymentTxHash: receipt?.hash ?? deploymentTx?.hash ?? null,
          blockNumber: receipt?.blockNumber ?? null,
        },
        accounts: {
          // Addresses only. No key material is ever written for a public chain.
          admin: wallet.address,
          pharmacies: {},
          delivery: {},
        },
        // Absent by design: `devKeys` exists only in the local deployment file.
        abi,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`\nMediMeshLedger: ${address}`);
  console.log(`Tx: ${receipt?.hash ?? deploymentTx?.hash}`);
  console.log(`Wrote ${outFile}`);
  console.log(
    "\nNext: point MM_LEDGER_DEPLOYMENT at this file. Pharmacy wallets must call " +
      "authorizePharmacy themselves — their keys are not in this file and never will be."
  );
}

function nativeSymbol(chainId: number): string {
  return chainId === 84532 || chainId === 8453 ? "ETH" : "ETH";
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});