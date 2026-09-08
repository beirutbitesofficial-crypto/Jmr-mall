import { integer, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const departments = sqliteTable("departments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meterSection: text("meter_section").notNull(),
  category: text("category").notNull().default(""), owner: text("owner").notNull().default(""),
  phone: text("phone").notNull().default(""), occupant: text("occupant").notNull().default(""),
  occupantNumber: text("occupant_number").notNull().default(""), rentStart: text("rent_start").notNull().default(""),
  rentEnd: text("rent_end").notNull().default(""), active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const monthlyRecords = sqliteTable("monthly_records", {
  id: integer("id").primaryKey({ autoIncrement: true }), month: text("month").notNull(),
  departmentId: integer("department_id").notNull().references(() => departments.id),
  meterFee: real("meter_fee").notNull().default(0), kiloPrice: real("kilo_price").notNull().default(0),
  rent: real("rent").notNull().default(0), services: real("services").notNull().default(0),
  previousReading: real("previous_reading").notNull().default(0), currentReading: real("current_reading").notNull().default(0),
  locked: integer("locked").notNull().default(0), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("idx_monthly_records_unique").on(table.month, table.departmentId), index("idx_monthly_records_month").on(table.month), index("idx_monthly_records_department_month").on(table.departmentId, table.month)]);

export const authLoginRateLimits = sqliteTable("auth_login_rate_limits", {
  clientKey: text("client_key").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  windowStartedAt: integer("window_started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [index("idx_auth_login_rate_limits_updated_at").on(table.updatedAt)]);
