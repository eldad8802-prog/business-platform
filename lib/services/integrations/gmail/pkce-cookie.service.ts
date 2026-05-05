import crypto from "crypto";

export type PkcePair = {
  codeVerifier: string;
  codeChallenge: string;
};

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createPkcePair(): PkcePair {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const digest = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64Url(digest);

  return { codeVerifier, codeChallenge };
}

