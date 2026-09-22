CREATE TABLE `jmr_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP,
	`action` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jmr_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT CURRENT_TIMESTAMP,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jmr_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL CHECK (`version` >= 0)
);
--> statement-breakpoint
ALTER TABLE `monthly_records` ADD `confirmed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE monthly_records SET confirmed=1 WHERE locked=1 AND current_reading>=previous_reading;
