import { log } from "./log.ts";
import { resetStore } from "./store.ts";

log.title("Resetting the store to a clean state");
for (const line of await resetStore()) log.ok(line);
