import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends ProjectEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type ProjectEnv = Env;
