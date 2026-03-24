export type ToolInputSchemaObject = Record<string, unknown>;

export function validateToolInputSchema(
  text: string,
): { ok: true; value: ToolInputSchemaObject } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Invalid JSON',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'Schema must be a JSON object.' };
  }
  return { ok: true, value: parsed as ToolInputSchemaObject };
}
