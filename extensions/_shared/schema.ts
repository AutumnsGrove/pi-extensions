/**
 * Schema helpers shared by extensions.
 *
 * `stringEnum()` builds the same schema as `StringEnum` from
 * `@earendil-works/pi-ai` (`{ type: "string", enum: [...] }`, which every
 * provider accepts). Inside pi that function returns a TypeBox `TUnsafe`, but
 * the published package (pi 1.5.0 onward) types it as a pi-schema `Schema`, so
 * `Static` widens every such parameter to `unknown` when extensions are
 * type-checked outside pi. Declaring the TypeBox type here keeps `pnpm check`
 * honest and matches what extensions get at run time.
 */

import { Type, type TUnsafe } from "typebox";

export function stringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}
