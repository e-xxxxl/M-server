import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { referenceData } from "./lib/reference.js";
import { accountRoutes } from "./routes/account.js";
import { adminRoutes } from "./routes/admin.js";
import { adminOpportunityRoutes } from "./routes/admin-opportunities.js";
import { adminOrganisationRoutes } from "./routes/admin-organisations.js";
import { opportunityRoutes } from "./routes/opportunities.js";
import { partnerRoutes } from "./routes/partner.js";
import { authRoutes } from "./routes/auth.js";
import { businessRoutes } from "./routes/business.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { verificationRoutes } from "./routes/verification.js";
import { documentRoutes } from "./routes/documents.js";
import { healthProfileRoutes } from "./routes/health-profile.js";
import { certificateRoutes, trainingOwnerRoutes } from "./routes/training.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { createLimiters, requireAllowedOrigin } from "./middleware/security.js";

/** Builds the Express app. Kept separate from server.js so tests can run it against an in-memory database. */
export function createApp(config, { log = true } = {}) {
  const app = express();
  const limiters = createLimiters(config);

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without an Origin header are not from a browser page, so CORS does not apply.
        callback(null, !origin || config.corsOrigins.includes(origin));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  // Request log without bodies, query strings or cookies, which can contain personal data.
  if (log) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on("finish", () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`));
      next();
    });
  }

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", limiters.general);
  app.use(express.json({ limit: "20kb" }));
  app.use(cookieParser());
  app.use("/api", requireAllowedOrigin(config.corsOrigins));

  // Allowed values for every list in the API (sectors, states and so on), so an app never has to hard-code them.
  app.get("/api/reference", (_req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(referenceData());
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", database: mongoose.connection.readyState === 1 });
  });
  app.use("/api/auth", authRoutes({ config, limiters }));
  app.use("/api/account", accountRoutes({ config, limiters }));
  app.use("/api/business", businessRoutes({ config }));
  app.use("/api/dashboard", dashboardRoutes({ config }));
  app.use("/api/verification", verificationRoutes({ config }));
  app.use("/api/documents", documentRoutes({ config }));
  app.use("/api/health-profile", healthProfileRoutes({ config }));
  app.use("/api/admin", adminRoutes({ config }));
  app.use("/api/admin", adminOpportunityRoutes({ config }));
  app.use("/api/admin", adminOrganisationRoutes({ config }));
  app.use("/api/partner", partnerRoutes({ config }));
  const owner = opportunityRoutes({ config });
  app.use("/api/opportunities", owner.opportunities);
  app.use("/api/applications", owner.applications);
  app.use("/api/notifications", owner.notifications);
  app.use("/api/consents", owner.consents);
  app.use("/api/training", trainingOwnerRoutes({ config }));
  app.use("/api/certificates", certificateRoutes({ limiter: limiters.reset }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
