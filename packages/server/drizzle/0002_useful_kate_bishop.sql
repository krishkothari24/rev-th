CREATE TABLE "sms_opt_outs" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL
);
