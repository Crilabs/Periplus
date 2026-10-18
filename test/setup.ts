import { setTransport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";

// Code that takes its transport from getTransport() (job handlers) replays recorded responses under test.
setTransport(fixtureTransport());
