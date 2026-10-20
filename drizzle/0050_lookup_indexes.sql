CREATE INDEX "external_calls_run_id_idx" ON "external_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "external_calls_tile_id_at_idx" ON "external_calls" USING btree ("tile_id","at");--> statement-breakpoint
CREATE INDEX "review_decisions_task_id_idx" ON "review_decisions" USING btree ("task_id");