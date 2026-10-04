/**
 * Query definitions per language, ported from lumen's
 * `internal/chunker/languages.go` for the languages we support. Lumen parses Go
 * with the native AST; we use tree-sitter-go with equivalent queries.
 *
 * Ordering matters: rules run general → specific, and equal-range chunks are
 * deduplicated keeping the later (more specific) rule.
 */

import type { QueryDef } from "./treesitter.ts";

export const GO_QUERIES: QueryDef[] = [
	{ pattern: `(function_declaration name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(method_declaration name: (field_identifier) @name) @decl`, kind: "method" },
	// Generic type first, interface after: equal-range chunks keep the later rule.
	{ pattern: `(type_spec name: (type_identifier) @name) @decl`, kind: "type" },
	{ pattern: `(type_spec name: (type_identifier) @name type: (interface_type)) @decl`, kind: "interface" },
	{ pattern: `(type_alias name: (type_identifier) @name) @decl`, kind: "type" },
	{ pattern: `(const_spec name: (identifier) @name) @decl`, kind: "const" },
	{ pattern: `(var_spec name: (identifier) @name) @decl`, kind: "var" },
];

export const TS_QUERIES: QueryDef[] = [
	// Exported const/let before the arrow-function patterns so arrow functions
	// are reclassified to "function" by the more specific rule below.
	{ pattern: `(export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @decl`, kind: "const" },
	{ pattern: `(function_declaration name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(generator_function_declaration name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @decl`, kind: "function" },
	{ pattern: `(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @decl`, kind: "function" },
	{ pattern: `(class_declaration name: (type_identifier) @name) @decl`, kind: "type" },
	{ pattern: `(abstract_class_declaration name: (type_identifier) @name) @decl`, kind: "type" },
	{ pattern: `(interface_declaration name: (type_identifier) @name) @decl`, kind: "interface" },
	{ pattern: `(type_alias_declaration name: (type_identifier) @name) @decl`, kind: "type" },
	{ pattern: `(enum_declaration name: (identifier) @name) @decl`, kind: "type" },
	{ pattern: `(method_definition name: (property_identifier) @name) @decl`, kind: "method" },
	{ pattern: `(method_signature name: (property_identifier) @name) @decl`, kind: "method" },
	{ pattern: `(internal_module name: (identifier) @name) @decl`, kind: "type" },
	{ pattern: `(ambient_declaration (function_signature name: (identifier) @name)) @decl`, kind: "function" },
];

export const JS_QUERIES: QueryDef[] = [
	{ pattern: `(export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @decl`, kind: "const" },
	{ pattern: `(function_declaration name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(generator_function_declaration name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @decl`, kind: "function" },
	{ pattern: `(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @decl`, kind: "function" },
	{ pattern: `(class_declaration name: (identifier) @name) @decl`, kind: "type" },
	{ pattern: `(method_definition name: (property_identifier) @name) @decl`, kind: "method" },
];

export const PYTHON_QUERIES: QueryDef[] = [
	{ pattern: `(function_definition name: (identifier) @name) @decl`, kind: "function" },
	{ pattern: `(class_definition name: (identifier) @name) @decl`, kind: "type" },
	{ pattern: `(decorated_definition definition: (function_definition name: (identifier) @name)) @decl`, kind: "function" },
	{ pattern: `(decorated_definition definition: (class_definition name: (identifier) @name)) @decl`, kind: "type" },
	{ pattern: `(assignment left: (identifier) @name) @decl`, kind: "var" },
];

export const BASH_QUERIES: QueryDef[] = [
	{ pattern: `(function_definition name: (word) @name) @decl`, kind: "function" },
	{ pattern: `(variable_assignment name: (variable_name) @name) @decl`, kind: "var" },
];
