# M-BOX security fork of picomatch 4.0.7

This is a private, locally maintained MIT-licensed fork, not an official upstream
release. Original authorship/license are preserved. The public npm advisory does
not audit this fork; our source-integrity and exploit regression gate is mandatory.

GHSA-fc5q-39xc-vjpf lets repeated extglobs such as `+(*)` and `+(*a)` emit nested
unbounded regular-expression quantifiers. Before regex construction this fork
throws `SyntaxError` with code `ERR_UNSAFE_EXTGLOB` for a `+(...)` or `*(...)`
containing unescaped quantifiers, nested groups or braces. Alternatives are
accepted only when they are prefix-free nonempty literals. This also rejects
raw-regex repetitions such as `+(a+)` and ambiguous `+(ab|abab)`. Quotes,
escapes and bracket classes are respected. `maxExtglobRecursion: false` does not
bypass the guard. `noextglob` still treats syntax as ordinary glob literals.

This deliberately rejects some previously accepted unsafe *configuration*
patterns (including `+(*.js)`); it does not silently reinterpret deny patterns.
Normal globs, globstars, braces, literal repetition, finite extglobs outside repeated groups, ignore rules,
scan, callbacks and module entry points retain upstream behavior. The repository
uses no rejected patterns. Validate discovery sets, build output, browser behavior
and full database regression before release. Do not claim universal compatibility
with every historical picomatch pattern.

`provenance.json` records upstream archive integrity and source hashes. Only
`lib/parse.js` changes; metadata identifies the fork. The reviewed source is packed
as a local tarball and locked with SHA-512 integrity. `test:glob-security` compares
installed code to the reviewed source and checks every transitive consumer.
Keep the npm audit threshold unchanged. Replace this fork with an official patched
release after running the same regression gate; never silently update the archive.

The mbox.3 revision additionally rejects opaque numeric/alphabetic regex escapes,
compares ASCII alternatives under the effective case-insensitive flags, and
rejects Unicode case folding in repeated alternatives. Repeated character classes
are restricted to simple positive classes/ranges that cannot include the '['
character, preventing ambiguity with picomatch's literal-bracket fallback.
This is a targeted glob security boundary, not a sandbox for caller-supplied
raw regex options (for example `prepend`); options remain trusted configuration.
