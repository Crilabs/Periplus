CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_prefix_idx" ON "mcp_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_id_idx" ON "mcp_tokens" USING btree ("user_id");--> statement-breakpoint
-- The role of the MCP tool `sql` (plan 2026-10-26-periplus-mcp): read only, without users, logins, API keys, MCP tokens
-- and rate limits. Made its own login, without membership, in 0082. The role is cluster wide, hence created only when
-- missing; grants are per database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'periplus_mcp_reader') THEN
    CREATE ROLE periplus_mcp_reader NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT periplus_mcp_reader TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO periplus_mcp_reader;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO periplus_mcp_reader;--> statement-breakpoint
REVOKE ALL ON "users", "login_attempts", "api_clients", "mcp_tokens", "rate_limits" FROM periplus_mcp_reader;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO periplus_mcp_reader;
