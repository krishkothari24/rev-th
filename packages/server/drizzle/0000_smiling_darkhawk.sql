CREATE TYPE "public"."appointment_status" AS ENUM('booked', 'dispatched', 'complete', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('voice', 'sms');--> statement-breakpoint
CREATE TYPE "public"."conversation_outcome" AS ENUM('booked', 'flagged', 'transferred', 'abandoned', 'info_only');--> statement-breakpoint
CREATE TYPE "public"."emergency_reason" AS ENUM('gas_smell', 'no_heat_vulnerable', 'no_ac_vulnerable', 'no_heat_general', 'no_ac_general', 'other');--> statement-breakpoint
CREATE TYPE "public"."equipment_kind" AS ENUM('furnace', 'central_ac', 'heat_pump', 'mini_split', 'rooftop_unit', 'boiler');--> statement-breakpoint
CREATE TYPE "public"."membership_tier" AS ENUM('basic', 'comfort_club');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('routine', 'priority', 'emergency');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"technician_id" uuid,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"urgency" "urgency" DEFAULT 'routine' NOT NULL,
	"issue_summary" text NOT NULL,
	"equipment_id" uuid,
	"required_skills" text[] DEFAULT '{}' NOT NULL,
	"status" "appointment_status" DEFAULT 'booked' NOT NULL,
	"source_channel" "channel" NOT NULL,
	"source_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"customer_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" "conversation_outcome",
	"transcript" jsonb,
	"disposition_summary" text,
	CONSTRAINT "conversations_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"county" text NOT NULL,
	"property_type" "property_type" DEFAULT 'residential' NOT NULL,
	"membership_tier" "membership_tier",
	"dnc" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "emergency_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"call_id" text NOT NULL,
	"reason" "emergency_reason" NOT NULL,
	"address_snapshot" text,
	"phone_snapshot" text,
	"notes" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "equipment_kind" NOT NULL,
	"install_year" integer,
	"last_service_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "technicians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"home_county" text NOT NULL,
	"skills" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"result" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_flags" ADD CONSTRAINT "emergency_flags_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_tech_start_idx" ON "appointments" USING btree ("technician_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_start_idx" ON "appointments" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "conversations_started_idx" ON "conversations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "customers_county_idx" ON "customers" USING btree ("county");--> statement-breakpoint
CREATE INDEX "emergency_flags_created_idx" ON "emergency_flags" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_flags_call_idx" ON "emergency_flags" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "equipment_customer_idx" ON "equipment" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_conversation_idx" ON "tool_invocations" USING btree ("conversation_id");