import { Router } from "express";
import { prisma } from "../db.js";
import { decrypt } from "../jira/crypto.js";
import { JiraError, listFields, type JiraField } from "../jira/client.js";

const router = Router();
const TTL_MS = 24 * 60 * 60 * 1000;

export type CachedFields = {
  cached: boolean;
  fetchedAt: string;
  fields: JiraField[];
};

export async function getCachedFields(
  connectionId: string,
  opts?: { refresh?: boolean },
): Promise<CachedFields> {
  const conn = await prisma.jiraConnection.findUnique({ where: { id: connectionId } });
  if (!conn) {
    throw new Error("Connection not found");
  }
  const cache = await prisma.fieldCache.findUnique({
    where: { connectionId: conn.id },
  });
  const fresh = cache && Date.now() - cache.fetchedAt.getTime() < TTL_MS;
  if (cache && fresh && !opts?.refresh) {
    return {
      cached: true,
      fetchedAt: cache.fetchedAt.toISOString(),
      fields: JSON.parse(cache.fields) as JiraField[],
    };
  }
  const fields = await listFields({
    baseUrl: conn.baseUrl,
    email: conn.email,
    apiToken: decrypt(conn.apiToken),
  });
  const saved = await prisma.fieldCache.upsert({
    where: { connectionId: conn.id },
    create: {
      connectionId: conn.id,
      fields: JSON.stringify(fields),
    },
    update: {
      fetchedAt: new Date(),
      fields: JSON.stringify(fields),
    },
  });
  return {
    cached: false,
    fetchedAt: saved.fetchedAt.toISOString(),
    fields,
  };
}

router.get("/:connectionId", async (req, res) => {
  const refresh = req.query.refresh === "1";
  try {
    const result = await getCachedFields(req.params.connectionId, { refresh });
    res.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Connection not found") {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    if (err instanceof JiraError) {
      res.status(502).json({
        error: `JIRA returned ${err.status}`,
        details: err.body,
      });
      return;
    }
    throw err;
  }
});

export default router;
