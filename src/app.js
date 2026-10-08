import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import { accountRoutes } from "./routes/account.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { businessRoutes } from "./routes/business.js";
import { dashboardRoutes } from "./routes/dashboard.js";
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
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type"],
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

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", database: mongoose.connection.readyState === 1 });
  });
  app.use("/api/auth", authRoutes({ config, limiters }));
  app.use("/api/account", accountRoutes({ config, limiters }));
  app.use("/api/business", businessRoutes({ config }));
  app.use("/api/dashboard", dashboardRoutes({ config }));
  app.use("/api/admin", adminRoutes({ config }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
