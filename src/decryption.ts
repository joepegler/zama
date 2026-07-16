import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { config } from "./config.js";
import type { Address, Transfer } from "./indexer.js";

const transport = http(config.rpcUrl);
const account = privateKeyToAccount(config.privateKey);
const chain = {
  ...zamaSepolia,
  network: config.rpcUrl,
  ...(config.relayerApiKey
    ? { auth: { __type: "ApiKeyHeader" as const, value: config.relayerApiKey } }
    : {})
};

const sdk = new ZamaSDK(
  createConfig({
    chains: [chain],
    publicClient: createPublicClient({ chain: sepolia, transport }),
    walletClient: createWalletClient({ account, chain: sepolia, transport }),
    storage: new MemoryStorage(),
    relayers: { [chain.id]: node({ timeout: 15_000 }) }
  })
);

export async function decryptAmount(transfer: Transfer): Promise<bigint | null> {
  const input = [
    {
      encryptedValue: transfer.encryptedValue,
      contractAddress: config.tokenAddress
    }
  ];
  let lastError: unknown;

  try {
    const result = await sdk.decryption.decryptValues(input, { timeout: 15_000 });
    return BigInt(result[transfer.encryptedValue]!);
  } catch (error) {
    lastError = error;
  }

  const parties = new Set(
    [
      transfer.fromAddress,
      transfer.activityKind === "unshield" ? null : transfer.toAddress
    ].filter(
      (address): address is Address => address !== null && address !== ZERO_ADDRESS
    )
  );
  for (const party of parties) {
    try {
      const result = await sdk.decryption.delegatedDecryptValues(input, party, undefined, {
        waitForPropagation: false
      });
      return BigInt(result[transfer.encryptedValue]!);
    } catch (error) {
      lastError = error;
    }
  }

  console.warn(
    `Decryption pending for ${transfer.id}:`,
    lastError instanceof Error ? lastError.message : lastError
  );
  return null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
