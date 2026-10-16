import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";

// The MediMesh application reads the deployed address + ABI from
// blockchain/deployments/local.json, which scripts/deploy.ts writes. The
// Next.js server never compiles Solidity itself.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Deterministic bytecode across machines.
      metadata: { bytecodeHash: "none" },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // Public testnets.
    //
    // Base Sepolia is the target for a public demo: it is an EVM chain with a
    // free faucet, so the ledger can be pointed at something other than this
    // laptop without costing anything. The RPC URL and key come from the
    // environment — nothing is hardcoded here.
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "",
      chainId: 84532,
      accounts: process.env.MM_DEPLOYER_PRIVATE_KEY ? [process.env.MM_DEPLOYER_PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      chainId: 11155111,
      accounts: process.env.MM_DEPLOYER_PRIVATE_KEY ? [process.env.MM_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 60_000,
  },
};

export default config;
