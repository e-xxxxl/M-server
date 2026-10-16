import { ApiError } from "../middleware/errors.js";

/**
 * CAC and TIN are asked as a Yes or No question first. Yes needs the number, No stores "No" and no number.
 * `flag` is the answer field and `value` is the number field.
 */
const pairs = [
  { flag: "hasCac", value: "cacNumber", label: "CAC registration number" },
  { flag: "hasTin", value: "tin", label: "Tax Identification Number" },
];

/**
 * Makes the answer and the number agree. `doc` is the full profile (a plain object or a Mongoose
 * document) and `sent` holds what the caller actually supplied.
 * - A number sent without an answer counts as Yes.
 * - No clears the number.
 * - Yes without a number is rejected.
 * `prefix` is "business." when the errors belong to the registration form.
 */
export function applyComplianceRules(doc, sent, prefix = "") {
  const errors = {};
  for (const { flag, value, label } of pairs) {
    const number = typeof sent[value] === "string" ? sent[value].trim() : "";
    if (number && sent[flag] === undefined) doc[flag] = "Yes";
    const answer = doc[flag] ?? "";
    if (answer === "No") {
      doc[value] = "";
    } else if (answer === "Yes" && !String(doc[value] ?? "").trim()) {
      errors[`${prefix}${value}`] = `Enter your ${label}.`;
    } else if (answer === "" && String(doc[value] ?? "").trim()) {
      doc[flag] = "Yes"; // an older profile that has a number but no answer
    }
  }
  if (Object.keys(errors).length > 0) {
    throw new ApiError(422, "validation", "Please check the highlighted fields.", errors);
  }
}
