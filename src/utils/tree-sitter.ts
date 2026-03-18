/**
 * Shared tree-sitter utilities.
 *
 * tree-sitter 0.21.x has a native binding bug: its internal UTF-16 buffer is
 * 32 768 uint16 units (32 768 characters for BMP text). When the JS input
 * callback returns a string >= 32 768 chars, `napi_get_value_string_utf16`
 * overflows and the C layer throws "Invalid argument". Work around this by
 * supplying a chunked callback for large sources instead of a raw string.
 */

import type Parser from 'tree-sitter';

const TS_SAFE_CHUNK = 32_767;

export function safeParse(parser: Parser, source: string): Parser.Tree {
  if (source.length < TS_SAFE_CHUNK) {
    return parser.parse(source);
  }
  return parser.parse((offset: number) => source.slice(offset, offset + TS_SAFE_CHUNK));
}
