// Tries each Prembly check once against Prembly's TEST MODE and prints what came back. Usage: npm run prembly-check
//
// Reads PREMBLY_API_KEY (and PREMBLY_BASE_URL if set) from backend/.env. The key is never printed. It prints only the
// shape of each answer (status, code, message and the NAMES of the fields), never the values, so nothing personal is
// shown even if the account is in live mode.
//
// Safety: a live Prembly call costs money. The script refuses to run unless the key starts with "test_" (Prembly's test
// keys do). To run it against a live key on purpose, add the word live: npm run prembly-check -- live
import "dotenv/config";

const key = process.env.PREMBLY_API_KEY ?? "";
const base = (process.env.PREMBLY_BASE_URL ?? "https://api.prembly.com").replace(/\/+$/, "");
const live = process.argv.includes("live");

if (!key) {
  console.error("PREMBLY_API_KEY is not set in backend/.env. Add the test key there first (never commit that file).");
  process.exit(1);
}
if (!key.startsWith("test_") && !live) {
  console.error('This key does not start with "test_", so it looks like a live key and each call would be billed.\nUse the test key, or run: npm run prembly-check -- live');
  process.exit(1);
}

// The sample numbers from Prembly's documentation. In test mode any value is accepted.
const checks = [
  ["NIN", "/verification/vnin-basic", { number: "56182742701" }],
  ["BVN", "/verification/bvn_validation", { number: "54651333604" }],
  ["CAC", "/verification/cac/basic", { rc_number: "092932", company_type: "RC" }],
  ["TIN (channel TIN, what NMREP sends)", "/verification/tin", { number: "12345678-0001", channel: "TIN" }],
  ["TIN (channel CAC, the documentation sample)", "/verification/tin", { number: "Rc323479", channel: "CAC" }],
];

for (const [label, path, body] of checks) {
  try {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => null);
    console.log(`\n${label}: HTTP ${res.status}`);
    if (!json) {
      console.log("  no JSON in the answer");
      continue;
    }
    console.log(`  status=${json.status} response_code=${json.response_code} is_sandbox=${json.is_sandbox ?? "not stated"}`);
    console.log(`  message: ${String(json.detail ?? json.message ?? "").slice(0, 160)}`);
    console.log(`  data fields: ${json.data && typeof json.data === "object" ? Object.keys(json.data).join(", ") : "none"}`);
    console.log(`  reference: ${json.verification?.reference ? "present" : json.reference_id ? "reference_id present" : "none"}`);
  } catch (err) {
    console.log(`\n${label}: failed (${err?.name ?? "error"})`);
  }
}
console.log("\nDone. Compare these field names with backend/src/lib/prembly.js.");
