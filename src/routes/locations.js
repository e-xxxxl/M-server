import { Router } from "express";
import { z } from "zod";
import { lgaList } from "../lib/lgas.js";
import { ApiError } from "../middleware/errors.js";
import { states } from "../options.js";

const querySchema = z.object({ state: z.string().trim().optional() }).strict();

/**
 * The local government areas to offer in a dropdown. Public, like the other reference lists. `version` changes whenever the
 * list does, so a client can keep its copy until then. With ?state=Lagos only that state's areas come back.
 */
export function locationRoutes() {
  const router = Router();
  router.get("/", async (req, res) => {
    const { state } = querySchema.parse(req.query);
    if (state && !states.includes(state)) {
      throw new ApiError(422, "validation", "Please check the highlighted fields.", { state: "Choose one of the listed states." });
    }
    res.json(await lgaList(state || null));
  });
  return router;
}
