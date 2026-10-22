/**
 * Report an Operation Object's `callbacks` (OpenAPI 3.x), which the parser
 * does not read.
 *
 * A callback is a request the API makes back to a URL the caller supplied in
 * the operation's request: a path item keyed by a runtime expression such as
 * `{$request.body#/callbackUrl}`. The IR has no node for a request tied to
 * the operation that provoked it, so a callback's request body never becomes
 * a model and an SDK cannot type what it receives. Rather than lose that
 * quietly, every site that reads an operation declaring at least one
 * callback says so once, with the callback keys, the way a document carrying
 * `x-webhooks` is told (see `warnOnLegacyWebhooks` in `parse.ts`). The path
 * item under a callback has the shape of a `webhooks` entry, which is read,
 * so the message says where to declare it to have its payload typed.
 *
 * Shared by the two sites that read an Operation Object — a `paths` operation
 * (`buildOperation`, once per operation) and a `webhooks` (key, method) entry
 * (`collectWebhookEntries`, once per entry: two keys that `$ref` one
 * `components/pathItems` entry are two sites and are each reported) — so the
 * two cannot drift. `label` names the site as the other warnings do: the
 * `operationId`, else `METHOD /path`; `webhooks.<key>.<method>` for a
 * webhook. An empty map, or a value that is not a map, declares no callback
 * and is silent. A `$ref` into `components/callbacks` is reported at the
 * operation that writes it, under its key; an entry there that no operation
 * references is not reported, since nothing reaches it.
 */
export function warnOnIgnoredCallbacks(callbacks: unknown, label: string): void {
  if (typeof callbacks !== 'object' || callbacks === null || Array.isArray(callbacks)) return;
  const names = Object.keys(callbacks);
  if (names.length === 0) return;
  console.warn(
    `[oagen] Warning: \`callbacks\` on ${label} are not read (${names.map((name) => `"${name}"`).join(', ')}); ` +
      "the operation is parsed without them. Declare each callback's request under the top-level " +
      '`webhooks` map (OpenAPI 3.1) to have its payload typed.',
  );
}
