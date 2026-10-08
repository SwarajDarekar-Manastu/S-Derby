import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { releaseShipService } from "../services/release-ship.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export const shipReleaseSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict();

export function releaseShipRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/release-ship", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await releaseShipService(db).status(companyId));
  });

  router.post("/companies/:companyId/release-ship", validate(shipReleaseSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await releaseShipService(db).ship(companyId, req.body.repo, req.actor.userId ?? null));
  });

  return router;
}
