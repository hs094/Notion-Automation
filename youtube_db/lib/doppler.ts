import { DopplerSDK } from "@dopplerhq/node-sdk";

// ponytail: hardcoded on purpose — user owns project/config names, no env indirection.
const DOPPLER_PROJECT = "notion-automation";
const DOPPLER_CONFIG = "prd";

let done = false;

// Fetches Doppler secrets at runtime using DOPPLER_TOKEN for auth only.
// Injects missing keys into process.env (local env wins). Never logs values.
export async function initDoppler(): Promise<void> {
  if (done) return;
  done = true;
  const token = process.env.DOPPLER_TOKEN;
  if (!token) return;
  let secrets: Record<string, unknown>;
  try {
    const sdk = new DopplerSDK({ accessToken: token });
    const res = await sdk.secrets.download(DOPPLER_PROJECT, DOPPLER_CONFIG, {
      format: "json",
    });
    secrets = res as unknown as Record<string, unknown>;
  } catch (err) {
    // ponytail: scalar fields only — never dump whole error object (could carry payloads)
    const e = err as { message?: unknown; title?: unknown; detail?: unknown; statusCode?: unknown };
    const parts = [e?.title, e?.detail, e?.message].filter(
      (x): x is string =>
        typeof x === "string" && x.length > 0 && x !== "[object Object]",
    );
    const status =
      typeof e?.statusCode === "number" ? ` (HTTP ${e.statusCode})` : "";
    throw new Error(`Doppler fetch failed${status}: ${parts.join(" — ") || "unknown error"}`);
  }
  let injected = 0;
  for (const [k, v] of Object.entries(secrets ?? {})) {
    if (typeof v !== "string" || process.env[k] !== undefined) continue;
    process.env[k] = v;
    injected++;
  }
  // count only — never names/values/token
  console.log(`Doppler: ${injected} secret(s) loaded`);
}
