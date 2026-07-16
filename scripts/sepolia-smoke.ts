/// <reference types="node" />
import "dotenv/config";
import {
  DelegationExpiryUnchangedError,
  DelegationNotFoundError,
  MemoryStorage,
  ZamaSDK,
} from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { node } from "@zama-fhe/sdk/node";
import { createConfig } from "@zama-fhe/sdk/viem";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const API_URL = "http://localhost:42069";
const EXPLORER = sepolia.blockExplorers!.default.url;
const TOKEN = required("TOKEN_ADDRESS") as Address;
const UNDERLYING = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF" as Address; // USDCMock
const ALICE_PRIVATE_KEY = required("ALICE_PK") as `0x${string}`;
const alice = privateKeyToAccount(ALICE_PRIVATE_KEY);
const bob = privateKeyToAccount(generatePrivateKey());
const SHIELD_AMOUNT = 5_000_000n;
const TRANSFER_AMOUNT = 1_000_000n;
const WAIT_SECONDS = 5;

async function main() {
  logStep(
    "Starting Sepolia smoke demo for ERC-7984 indexing, decryption, and API reads.",
  );
  const rpcUrl = required("SEPOLIA_RPC_URL");
  const indexer = privateKeyToAccount(
    required("INDEXER_PRIVATE_KEY") as `0x${string}`,
  );
  logInfo(`Alice: ${explorerAddress(alice.address)}`);
  logInfo(`Bob (ephemeral): ${explorerAddress(bob.address)}`);
  logInfo(`Indexer delegate: ${explorerAddress(indexer.address)}`);
  logInfo(`Confidential token: ${explorerAddress(TOKEN)}`);
  logInfo(`Underlying token: ${explorerAddress(UNDERLYING, "USDCMock")}`);
  logInfo(`API base: ${apiLink("/api/health", API_URL)}`);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({
    account: alice,
    chain: sepolia,
    transport,
  });
  const chain = { ...zamaSepolia, network: rpcUrl };
  const sdk = new ZamaSDK(
    createConfig({
      chains: [chain],
      publicClient: publicClient as PublicClient,
      walletClient: walletClient as WalletClient,
      storage: new MemoryStorage(),
      relayers: { [chain.id]: node({ timeout: 30_000 }) },
    }),
  );

  try {
    logStep("Waiting for indexer to catch up before reading balances.");
    await waitFor<{ behind: boolean }>(
      "/api/health",
      (health) => !health.behind,
    );

    logStep(
      "Revoking any existing delegation so the first transfer can demonstrate pending decryption.",
    );
    await ensureDelegationInactive(sdk, alice.address, indexer.address);

    logStep("Reading starting balances from the partner-facing API.");
    const senderBefore = await balance(alice.address);
    const recipientBefore = await balance(bob.address);
    logInfo(
      `Sender starting balance: ${senderBefore} ${apiLink(`/balances/${alice.address}`, "(API)")}`,
    );
    logInfo(
      `Recipient starting balance: ${recipientBefore} ${apiLink(`/balances/${bob.address}`, "(API)")}`,
    );

    logStep("Minting underlying test tokens for Alice.");
    const mintHash = await walletClient.writeContract({
      address: UNDERLYING,
      abi: mintAbi,
      functionName: "mint",
      args: [alice.address, 10_000_000n],
      account: alice,
      chain: sepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
    logInfo(`Mint tx: ${explorerTx(mintHash)}`);

    logStep("Shielding into the confidential wrapped token.");
    const wrapped = sdk.createWrappedToken(TOKEN);
    const shield = await wrapped.shield(SHIELD_AMOUNT);
    logInfo(`Shield tx: ${explorerTx(shield.txHash)}`);

    logStep(
      "Sending one confidential transfer before re-delegating (to surface pending state).",
    );
    const transfer = await wrapped.confidentialTransfer(
      bob.address,
      TRANSFER_AMOUNT,
    );
    logInfo(`Transfer tx: ${explorerTx(transfer.txHash)}`);

    logStep("Waiting until this transfer appears in the API history.");
    const transferRow = await waitForTransferRow(alice.address, transfer.txHash);
    logInfo(
      `Initial transfer state from API: ${transferRow.amount.state}${
        transferRow.amount.value === null ? "" : ` (${transferRow.amount.value})`
      } ${apiLink(`/transfers/${alice.address}`, "(history)")}`,
    );

    if (transferRow.amount.state === "pending_decryption") {
      logStep(
        "Transfer is pending decryption, delegating rights so the indexer can backfill cleartext.",
      );
      try {
        const delegation = await sdk.delegations.delegateDecryption({
          contractAddress: TOKEN,
          delegateAddress: indexer.address,
        });
        logInfo(`Delegation tx: ${explorerTx(delegation.txHash)}`);
      } catch (error) {
        if (!(error instanceof DelegationExpiryUnchangedError)) throw error;
        logInfo("Delegation already configured (expiry unchanged).");
      }
      await waitForCondition(
        "delegation to become active",
        async () =>
          sdk.delegations.isActive({
            contractAddress: TOKEN,
            delegatorAddress: alice.address,
            delegateAddress: indexer.address,
          }),
      );
    } else {
      logInfo(
        "Transfer was already decrypted immediately, likely because delegation already existed.",
      );
    }

    logStep("Waiting for decrypted cleartext amount to be returned by the API.");
    await waitFor<{
      data?: Array<{
        transactionHash: string;
        amount: { state: string; value: string | null };
      }>;
    }>(`/transfers/${alice.address}`, (history) =>
      Boolean(
        history.data?.some(
          (row) =>
            row.transactionHash === transfer.txHash &&
            row.amount.state === "decrypted" &&
            row.amount.value === TRANSFER_AMOUNT.toString(),
        ),
      ),
    );
    logInfo(
      `Transfer now appears as decrypted in API history ${apiLink(`/transfers/${alice.address}`, "(history)")}.`,
    );

    logStep("Re-reading balances and asserting final expected values.");
    const sender = await balance(alice.address);
    const recipient = await balance(bob.address);
    if (sender !== senderBefore + SHIELD_AMOUNT - TRANSFER_AMOUNT) {
      throw new Error(`Unexpected sender balance: ${sender}`);
    }
    if (recipient !== recipientBefore + TRANSFER_AMOUNT) {
      throw new Error(`Unexpected recipient balance: ${recipient}`);
    }

    logInfo(
      `Sender final balance: ${sender} ${apiLink(`/balances/${alice.address}`, "(API)")}`,
    );
    logInfo(
      `Recipient final balance: ${recipient} ${apiLink(`/balances/${bob.address}`, "(API)")}`,
    );
    logInfo(
      `Health snapshot ${apiLink("/api/health", "(API)")}: ${JSON.stringify(await get("/api/health"))}`,
    );
    logStep("Sepolia smoke demo passed.");
  } finally {
    sdk.terminate();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const mintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitFor<T>(
  path: string,
  done: (body: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      const body = (await (await fetch(`${API_URL}${path}`)).json()) as T;
      if (done(body)) return body;
    } catch {
      // The service may still be starting.
    }
    logInfo(
      `Waiting for ${apiLink(path)} (attempt ${attempt + 1}/36, next poll in ${WAIT_SECONDS}s).`,
    );
    await new Promise((resolve) => setTimeout(resolve, WAIT_SECONDS * 1_000));
  }
  throw new Error(`Timed out waiting for ${API_URL}${path}`);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) {
    throw new Error(`${API_URL}${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function ensureDelegationInactive(
  sdk: ZamaSDK,
  delegatorAddress: Address,
  delegateAddress: Address,
) {
  const active = await sdk.delegations.isActive({
    contractAddress: TOKEN,
    delegatorAddress,
    delegateAddress,
  });
  if (!active) {
    logInfo("Delegation already inactive.");
    return;
  }

  try {
    const revoke = await sdk.delegations.revokeDelegation({
      contractAddress: TOKEN,
      delegateAddress,
    });
    logInfo(`Revoke tx: ${explorerTx(revoke.txHash)}`);
  } catch (error) {
    if (!(error instanceof DelegationNotFoundError)) throw error;
    logInfo("Delegation not found during revoke; treating as already inactive.");
    return;
  }

  await waitForCondition("delegation revocation to propagate", async () =>
    sdk.delegations.isActive({
      contractAddress: TOKEN,
      delegatorAddress,
      delegateAddress,
    }).then((isActive) => !isActive),
  );
}

async function waitForCondition(
  label: string,
  done: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      if (await done()) return;
    } catch {
      // The service or gateway may still be starting.
    }
    logInfo(
      `Waiting for ${label} (attempt ${attempt + 1}/36, next poll in ${WAIT_SECONDS}s).`,
    );
    await new Promise((resolve) => setTimeout(resolve, WAIT_SECONDS * 1_000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function balance(address: Address) {
  const result = await get<{
    balance: { state: string; value: string | null };
  }>(`/balances/${address}`);
  if (result.balance.state !== "decrypted" || result.balance.value === null) {
    throw new Error(
      `Balance is not decrypted: ${JSON.stringify(result.balance)}`,
    );
  }
  return BigInt(result.balance.value);
}

async function waitForTransferRow(address: Address, txHash: string): Promise<{
  transactionHash: string;
  amount: { state: string; value: string | null };
}> {
  return waitFor<{
    data?: Array<{
      transactionHash: string;
      amount: { state: string; value: string | null };
    }>;
  }>(`/transfers/${address}`, (history) =>
    Boolean(history.data?.some((row) => row.transactionHash === txHash)),
  ).then((history) => {
    const row = history.data?.find((item) => item.transactionHash === txHash);
    if (!row) {
      throw new Error(
        `Missing transfer row for ${explorerTx(txHash)} in ${API_URL}/transfers/${address}`,
      );
    }
    return row;
  });
}

function logStep(message: string) {
  console.log(`\n=== ${message} ===`);
}

function logInfo(message: string) {
  console.log(`[demo] ${message}`);
}

/** OSC 8 hyperlink — clickable in VS Code, iTerm2, and most modern terminals. */
function terminalLink(url: string, label: string): string {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function explorerTx(txHash: string): string {
  return terminalLink(`${EXPLORER}/tx/${txHash}`, txHash);
}

function explorerAddress(address: string, label?: string): string {
  return terminalLink(`${EXPLORER}/address/${address}`, label ?? address);
}

function apiLink(path: string, label?: string): string {
  const url = `${API_URL}${path}`;
  return terminalLink(url, label ?? url);
}
