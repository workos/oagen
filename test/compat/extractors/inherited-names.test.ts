import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Extractor } from '../../../src/compat/types.js';
import { dotnetExtractor } from '../../../src/compat/extractors/dotnet.js';
import { elixirExtractor } from '../../../src/compat/extractors/elixir.js';
import { iosExtractor } from '../../../src/compat/extractors/ios.js';
import { kotlinExtractor } from '../../../src/compat/extractors/kotlin.js';
import { nodeExtractor } from '../../../src/compat/extractors/node.js';
import { phpExtractor } from '../../../src/compat/extractors/php.js';
import { pythonExtractor } from '../../../src/compat/extractors/python.js';
import { rubyExtractor } from '../../../src/compat/extractors/ruby.js';
import { rustExtractor } from '../../../src/compat/extractors/rust.js';
import { overloadsOf, sortRecord } from '../../../src/compat/extractors/shared.js';

/**
 * Every object inherits `toString`, `valueOf` and `constructor`, and all three
 * are legal method names in the languages below. Each SDK here declares the
 * first two next to an ordinary method, once for every kind of declaration
 * its extractor turns into a class with methods.
 *
 * Go is absent: its extractor keeps exported names only, and those start with
 * a capital letter.
 */
interface Sdk {
  extractor: Extractor;
  /** The classes as the extractor names them in the surface. */
  classes: string[];
  files: Record<string, string>;
}

const sdks: Record<string, Sdk> = {
  dotnet: {
    extractor: dotnetExtractor,
    classes: ['Snapshot'],
    files: {
      'src/Acme/Snapshot.cs': `namespace Acme
{
    public class Snapshot
    {
        public string toString()
        {
            return "";
        }

        public int valueOf(string name)
        {
            return 0;
        }

        public string describe()
        {
            return "";
        }
    }
}
`,
    },
  },
  elixir: {
    extractor: elixirExtractor,
    classes: ['Snapshot'],
    files: {
      'lib/acme/snapshot.ex': `defmodule Acme.Snapshot do
  @moduledoc """
  A snapshot.
  """

  def toString(snapshot), do: inspect(snapshot)

  def valueOf(snapshot), do: snapshot

  def describe(snapshot), do: inspect(snapshot)
end
`,
    },
  },
  ios: {
    extractor: iosExtractor,
    classes: ['Snapshot'],
    files: {
      'Sources/Acme/Snapshot.swift': `import Foundation

public struct Snapshot: Sendable {
    let generation: Int

    public func toString() -> String {
        return ""
    }

    public func valueOf(name: String) -> Int {
        return 0
    }

    public func describe() -> String {
        return ""
    }
}
`,
    },
  },
  kotlin: {
    extractor: kotlinExtractor,
    classes: ['Snapshot'],
    files: {
      'src/main/kotlin/com/acme/Snapshot.kt': `package com.acme

class Snapshot(val generation: Int) {
    override fun toString(): String = "Snapshot(generation=$generation)"

    fun valueOf(name: String): Int = 0

    fun describe(): String = "snapshot"
}
`,
    },
  },
  node: {
    extractor: nodeExtractor,
    classes: ['Snapshot'],
    files: {
      'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`,
      'src/index.ts': `export class Snapshot {
  toString(): string {
    return '';
  }

  valueOf(): number {
    return 0;
  }

  describe(): string {
    return '';
  }
}
`,
    },
  },
  php: {
    extractor: phpExtractor,
    classes: ['Snapshot'],
    files: {
      'lib/Snapshot.php': `<?php

namespace Acme;

class Snapshot
{
    /**
     * @return string
     */
    public function toString()
    {
        return '';
    }

    /**
     * @param string $name
     *
     * @return int
     */
    public function valueOf($name)
    {
        return 0;
    }

    /**
     * @return string
     */
    public function describe()
    {
        return '';
    }
}
`,
    },
  },
  python: {
    extractor: pythonExtractor,
    // A plain class, a Protocol and an exception each take their own path.
    classes: ['Snapshot', 'SnapshotModule', 'SnapshotError'],
    files: {
      'src/acme/__init__.py': `from acme.snapshot import Snapshot, SnapshotError, SnapshotModule
`,
      'src/acme/snapshot.py': `from typing import Protocol


class Snapshot:
    def toString(self) -> str:
        return ""

    def valueOf(self, name: str) -> int:
        return 0

    def describe(self) -> str:
        return ""


class SnapshotModule(Protocol):
    def toString(self) -> str: ...

    def valueOf(self, name: str) -> int: ...

    def describe(self) -> str: ...


class SnapshotError(Exception):
    def toString(self) -> str:
        return ""

    def valueOf(self, name: str) -> int:
        return 0

    def describe(self) -> str:
        return ""
`,
    },
  },
  ruby: {
    extractor: rubyExtractor,
    // A class, and a module whose methods sit in \`class << self\`.
    classes: ['Snapshot', 'Sessions'],
    files: {
      'lib/acme.rb': `# frozen_string_literal: true

require 'acme/snapshot'
`,
      'lib/acme/snapshot.rb': `# frozen_string_literal: true

module Acme
  class Snapshot
    def toString
      ''
    end

    def valueOf(name)
      0
    end

    def describe
      ''
    end
  end

  module Sessions
    class << self
      def toString
        ''
      end

      def valueOf(name)
        0
      end

      def describe
        ''
      end
    end
  end
end
`,
    },
  },
  rust: {
    extractor: rustExtractor,
    // A struct with an impl block, and a trait.
    classes: ['Snapshot', 'Describe'],
    files: {
      'src/lib.rs': `pub struct Snapshot {
    pub generation: u64,
}

impl Snapshot {
    pub fn toString(&self) -> String {
        todo!()
    }

    pub fn valueOf(&self, name: &str) -> i64 {
        todo!()
    }

    pub fn describe(&self) -> String {
        todo!()
    }
}

pub trait Describe {
    fn toString(&self) -> String;

    fn valueOf(&self, name: &str) -> i64;

    fn describe(&self) -> String;
}
`,
    },
  },
};

const roots: string[] = [];

function writeSdk(language: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `oagen-inherited-names-${language}-`));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('methods named like a member every object inherits', () => {
  it.each(Object.keys(sdks))('%s: extracts toString and valueOf as methods', async (language) => {
    const { extractor, classes, files } = sdks[language];
    const surface = await extractor.extract(writeSdk(language, files));

    expect(Object.keys(surface.classes).sort()).toEqual([...classes].sort());
    for (const className of classes) {
      const methods = surface.classes[className].methods;
      expect(Object.keys(methods)).toEqual(['describe', 'toString', 'valueOf']);
      for (const name of ['describe', 'toString', 'valueOf']) {
        expect(methods[name]).toHaveLength(1);
        expect(methods[name][0].name).toBe(name);
      }
    }
  });
});

describe('overloadsOf', () => {
  it.each(['toString', 'valueOf', 'constructor', 'hasOwnProperty'])('starts a list for %s', (name) => {
    const methods: Record<string, string[]> = {};

    overloadsOf(methods, name).push('first');

    expect(Object.keys(methods)).toEqual([name]);
    expect(methods[name]).toEqual(['first']);
  });

  it('returns the same list for a name it has seen', () => {
    const methods: Record<string, string[]> = {};

    overloadsOf(methods, 'toString').push('first');
    overloadsOf(methods, 'toString').push('second');
    overloadsOf(methods, 'describe').push('third');

    expect(methods).toEqual({ toString: ['first', 'second'], describe: ['third'] });
  });
});

/**
 * `__proto__` is a legal method name too, and the one key that assignment
 * cannot add to a record: `record['__proto__'] = value` goes to a setter every
 * object inherits, which replaces the record's prototype and adds no key.
 *
 * PHP and Python are absent: their parsers drop the name before any method is
 * grouped. PHP's skips every method that starts with `__` except
 * `__construct`, and Python's every method that starts with `_` except
 * `__init__`.
 */
const protoLanguages = ['dotnet', 'elixir', 'ios', 'kotlin', 'node', 'ruby', 'rust'];

/** The same sources, with the method called `from` called `to` instead. */
function renameMethod(files: Record<string, string>, from: string, to: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, source]) => [path, source.replaceAll(from, to)]));
}

/** Each of the record's own method names with the names of its overloads, in key order. */
function overloadNames(methods: Record<string, { name: string }[]>): [string, string[]][] {
  return Object.entries(methods).map(([name, overloads]) => [name, overloads.map((overload) => overload.name)]);
}

describe('a method called __proto__', () => {
  it.each(protoLanguages)('%s: extracts it as an own key that the written surface keeps', async (language) => {
    const { extractor, classes, files } = sdks[language];
    const surface = await extractor.extract(writeSdk(language, renameMethod(files, 'valueOf', '__proto__')));
    const written = JSON.parse(JSON.stringify(surface)) as typeof surface;

    const expected = [
      ['__proto__', ['__proto__']],
      ['describe', ['describe']],
      ['toString', ['toString']],
    ];
    for (const className of classes) {
      expect(overloadNames(surface.classes[className].methods)).toEqual(expected);
      expect(overloadNames(written.classes[className].methods)).toEqual(expected);
    }
  });

  it('overloadsOf starts its list under an own key and leaves the prototype alone', () => {
    const methods: Record<string, string[]> = {};

    overloadsOf(methods, '__proto__').push('first');
    overloadsOf(methods, '__proto__').push('second');

    expect(Object.entries(methods)).toEqual([['__proto__', ['first', 'second']]]);
    expect(Object.getPrototypeOf(methods)).toBe(Object.prototype);
  });

  it('sortRecord keeps the key and its value, in sorted order', () => {
    // JSON.parse gives the record an own `__proto__` key, as reading a written surface does.
    const record = JSON.parse('{"zeta":["z"],"__proto__":["p"],"alpha":["a"]}') as Record<string, string[]>;

    const sorted = sortRecord(record);

    expect(Object.entries(sorted)).toEqual([
      ['__proto__', ['p']],
      ['alpha', ['a']],
      ['zeta', ['z']],
    ]);
    expect(Object.getPrototypeOf(sorted)).toBe(Object.prototype);
  });
});
