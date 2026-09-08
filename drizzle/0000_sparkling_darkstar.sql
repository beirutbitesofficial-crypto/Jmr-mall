CREATE TABLE `departments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meter_section` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`occupant` text DEFAULT '' NOT NULL,
	`occupant_number` text DEFAULT '' NOT NULL,
	`rent_start` text DEFAULT '' NOT NULL,
	`rent_end` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`department_id` integer NOT NULL,
	`meter_fee` real DEFAULT 0 NOT NULL,
	`kilo_price` real DEFAULT 0 NOT NULL,
	`rent` real DEFAULT 0 NOT NULL,
	`services` real DEFAULT 0 NOT NULL,
	`previous_reading` real DEFAULT 0 NOT NULL,
	`current_reading` real DEFAULT 0 NOT NULL,
	`locked` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_monthly_records_unique` ON `monthly_records` (`month`,`department_id`);--> statement-breakpoint
CREATE INDEX `idx_monthly_records_month` ON `monthly_records` (`month`);--> statement-breakpoint
CREATE INDEX `idx_monthly_records_department_month` ON `monthly_records` (`department_id`,`month`);
