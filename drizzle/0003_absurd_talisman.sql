PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jmr_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "jmr_version_nonnegative" CHECK("__new_jmr_revision"."version" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_jmr_revision`("id", "version") SELECT "id", "version" FROM `jmr_revision`;--> statement-breakpoint
DROP TABLE `jmr_revision`;--> statement-breakpoint
ALTER TABLE `__new_jmr_revision` RENAME TO `jmr_revision`;--> statement-breakpoint
PRAGMA foreign_keys=ON;