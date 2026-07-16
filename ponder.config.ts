import { createConfig } from "ponder";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { config } from "./src/config.js";

const RETRY_START_BLOCK = 11_280_000;

const abi = [
  {
    type: "event",
    name: "ConfidentialTransfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "amount", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "Wrap",
    inputs: [
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "roundedAmount", type: "uint256" },
      { indexed: false, name: "encryptedWrappedAmount", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "UnwrapRequested",
    inputs: [
      { indexed: true, name: "receiver", type: "address" },
      { indexed: true, name: "unwrapRequestId", type: "bytes32" },
      { indexed: false, name: "amount", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "UnwrapFinalized",
    inputs: [
      { indexed: true, name: "receiver", type: "address" },
      { indexed: true, name: "unwrapRequestId", type: "bytes32" },
      { indexed: false, name: "encryptedAmount", type: "bytes32" },
      { indexed: false, name: "cleartextAmount", type: "uint64" }
    ]
  }
] as const;

const aclAbi = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    inputs: [
      { indexed: true, name: "delegator", type: "address" },
      { indexed: true, name: "delegate", type: "address" },
      { indexed: false, name: "contractAddress", type: "address" },
      { indexed: false, name: "delegationCounter", type: "uint64" },
      { indexed: false, name: "oldExpirationDate", type: "uint64" },
      { indexed: false, name: "newExpirationDate", type: "uint64" }
    ]
  }
] as const;

export default createConfig({
  chains: { sepolia: { id: 11_155_111, rpc: config.rpcUrl } },
  contracts: {
    ConfidentialWrapper: {
      abi,
      chain: "sepolia",
      address: config.tokenAddress,
      startBlock: config.startBlock
    },
    Acl: {
      abi: aclAbi,
      chain: "sepolia",
      address: zamaSepolia.aclContractAddress,
      startBlock: config.startBlock
    }
  },
  blocks: {
    RetryTick: {
      chain: "sepolia",
      startBlock: RETRY_START_BLOCK,
      interval: 5
    }
  }
});
