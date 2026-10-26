-- The MCP reader becomes its own login (plan 2026-10-26-periplus-mcp): a query run by the application user could switch
-- back from a role it is a member of (SET ROLE, set_config), so the tool `sql` connects as this role instead. Never
-- superuser, no member of the application user; read only and a statement timeout on the role itself. Its password is
-- set by hand (runbook „MCP“); without one the tool `sql` stays off.
ALTER ROLE periplus_mcp_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;--> statement-breakpoint
REVOKE periplus_mcp_reader FROM CURRENT_USER;--> statement-breakpoint
ALTER ROLE periplus_mcp_reader SET default_transaction_read_only = on;--> statement-breakpoint
ALTER ROLE periplus_mcp_reader SET statement_timeout = '15s';
