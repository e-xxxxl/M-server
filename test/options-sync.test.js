import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import * as options from "../src/options.js";

// The select options exist twice: here (to validate) and in the web app (to show).
// This test fails if they drift apart, so a value the form offers is never rejected by the API.

const web = fs.readFileSync(new URL("../../src/content/registration.ts", import.meta.url), "utf8");

describe("select options match the web app", () => {
  for (const [name, values] of Object.entries(options)) {
    if (name === "verificationStatuses") continue; // server-side only
    it(`${name}`, () => {
      for (const value of values) {
        assert.ok(web.includes(`"${value}"`), `"${value}" (${name}) is not in src/content/registration.ts`);
      }
    });
  }
});
