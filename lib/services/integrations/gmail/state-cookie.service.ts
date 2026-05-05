import crypto from "crypto";

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createOauthState(): string {
  return base64Url(crypto.randomBytes(32));
}

