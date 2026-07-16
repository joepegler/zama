import "dotenv/config";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  privateKey: required("INDEXER_PRIVATE_KEY") as `0x${string}`,
  relayerApiKey: process.env.RELAYER_API_KEY,
  rpcUrl: required("SEPOLIA_RPC_URL"),
  tokenAddress: required("TOKEN_ADDRESS") as `0x${string}`,
  startBlock: Number(required("TOKEN_START_BLOCK"))
} as const;
