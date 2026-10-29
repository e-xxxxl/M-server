import { ApiError } from "../middleware/errors.js";

/**
 * Turns the questions sent by a form into what is stored. A question that carries the id of an existing one keeps its
 * id (so saved answers stay tied to it); a question without an id is new. An unknown id is refused.
 */
export function normaliseQuestions(input, existing = []) {
  const known = new Set(existing.map((q) => String(q._id)));
  return (input ?? []).map((q, i) => {
    if (q.id) {
      if (!known.has(q.id)) throw new ApiError(422, "validation", "Please check the highlighted fields.", { [`questions.${i}.id`]: "This question does not exist." });
      return { _id: q.id, text: q.text, required: q.required };
    }
    return { text: q.text, required: q.required };
  });
}
