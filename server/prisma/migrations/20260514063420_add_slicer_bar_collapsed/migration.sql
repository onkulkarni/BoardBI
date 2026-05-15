-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "connectionId" TEXT NOT NULL,
    "jql" TEXT NOT NULL DEFAULT '',
    "layout" TEXT NOT NULL DEFAULT '[]',
    "pageSlicers" TEXT NOT NULL DEFAULT '[]',
    "slicerBarCollapsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Report_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "JiraConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("connectionId", "createdAt", "description", "id", "jql", "layout", "name", "pageSlicers", "updatedAt") SELECT "connectionId", "createdAt", "description", "id", "jql", "layout", "name", "pageSlicers", "updatedAt" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
