CREATE TABLE IF NOT EXISTS `auth_login_rate_limits` (
	`client_key` text PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_login_rate_limits_updated_at` ON `auth_login_rate_limits` (`updated_at`);
--> statement-breakpoint
PRAGMA optimize;
