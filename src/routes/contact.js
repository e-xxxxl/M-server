import { Router } from "express";
import { z } from "zod";
import { mailer } from "../lib/mailer.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, requirePasswordChanged, requireRole } from "../middleware/security.js";
import { audit } from "../models/AuditLog.js";
import { ContactMessage } from "../models/ContactMessage.js";
import { idParamSchema } from "../schemas.js";

// Same limits as the form on the website. Control characters are stripped; the message keeps its line breaks.
const plain = (max) => z.string().trim().max(max).transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""));
const contactSchema = z
  .object({
    name: plain(100).pipe(z.string().min(2, "Please enter your full name.")),
    email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Please enter a valid email address."),
    phone: plain(20).refine((v) => v === "" || /^\+?[0-9][0-9\s()-]{5,}$/.test(v), "Please enter a valid phone number, or leave this blank.").default(""),
    subject: plain(120).pipe(z.string().min(3, "Please enter a subject.")),
    message: plain(2000).pipe(z.string().min(10, "Please write a message of at least 10 characters.")),
    // A hidden field that people never fill in. Bots do. Anything in it is dropped without a word.
    website: z.string().max(200).default(""),
  })
  .strict();

/** The public contact form, and the staff list of what was sent. */
export function contactRoutes({ config, limiter }) {
  const router = Router();

  router.post("/", limiter, async (req, res) => {
    const { website, ...input } = contactSchema.parse(req.body);
    if (website) return void res.status(201).json({ received: true }); // a bot: look pleased, keep nothing
    const saved = await ContactMessage.create(input);
    // The inbox copy is a courtesy: the message is already kept, so a mail failure never fails the form. The message text is never logged.
    if (mailer.enabled && config.contact.inbox) {
      void mailer
        .send({
          to: config.contact.inbox,
          subject: `Website enquiry: ${input.subject}`.slice(0, 150),
          text: `From: ${input.name} <${input.email}>${input.phone ? `, ${input.phone}` : ""}\n\n${input.message}\n\n(Kept in the admin portal under Enquiries, reference ${saved._id}.)`,
        })
        .catch(() => null);
    }
    res.status(201).json({ received: true });
  });

  const staff = Router();
  staff.use(requireAuth(config), requireRole("admin", "super_admin"), requirePasswordChanged);

  staff.get("/", async (req, res) => {
    const only = req.query.handled === "true" ? true : req.query.handled === "false" ? false : null;
    const items = await ContactMessage.find(only === null ? {} : { handled: only }).sort({ createdAt: -1 }).limit(200);
    res.json({ items, open: await ContactMessage.countDocuments({ handled: false }) });
  });

  staff.post("/:id/handled", async (req, res) => {
    const parsed = idParamSchema.safeParse(req.params.id);
    const message = parsed.success ? await ContactMessage.findById(parsed.data) : null;
    if (!message) throw new ApiError(404, "not_found", "Not found.");
    const handled = req.body?.handled !== false;
    message.handled = handled;
    message.handledAt = handled ? new Date() : null;
    await message.save();
    await audit(req.user, "contact.handled", `Marked an enquiry from ${message.name} as ${handled ? "answered" : "not answered"}`, { type: "contact", id: message._id });
    res.json({ item: message });
  });

  return { publicRouter: router, staffRouter: staff };
}

