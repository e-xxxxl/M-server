import { ZodError } from "zod";

/** An error with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const unauthenticated = () =>
  new ApiError(401, "unauthenticated", "You need to log in to continue.");

export function notFound(_req, res) {
  res.status(404).json({ error: { code: "not_found", message: "Not found." } });
}

/**
 * Last-resort handler. Responses never include stack traces or internal details, and
 * request bodies (which can hold passwords) are never logged.
 */
// Express recognises an error handler by its four arguments, so `_next` must stay even though it is unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) {
      const key = issue.path.length ? issue.path.join(".") : "_";
      if (!fields[key]) fields[key] = issue.code === "unrecognized_keys" ? "Unknown field." : issue.message;
    }
    return res.status(422).json({ error: { code: "validation", message: "Please check the highlighted fields.", fields } });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "The request could not be read." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "too_large", message: "The request is too large." } });
  }
  console.error("Unhandled error:", err?.name, err?.message);
  return res.status(500).json({ error: { code: "server_error", message: "Something went wrong. Please try again." } });
}
