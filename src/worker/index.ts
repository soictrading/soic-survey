import { createApp } from "./app";
import { remoteAccessKeys } from "./auth";
import type { Env } from "./env";
import { anthropicCaller } from "./model";

const app = createApp({ accessKeys: remoteAccessKeys, model: anthropicCaller });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
