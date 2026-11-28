# Comparing a new text with the one a pack quotes

Status: built. Code: `packages/standard-packs/src/pack-compare.ts` (the comparison), `pack-compare-printout.ts` (the report a person reads), `pack-next-version.ts` (`--write-next`), `pack-settle.ts` (the marker and the refusal of `pnpm pack:build`) and `pack-cli.ts` (the command). Tests: `packages/standard-packs/tests/pack-compare.test.ts`. Worked example: `packages/standard-packs/examples/invented-waiver/` with `amendment-1.txt`, an invented second edition of its text.

A rule pack quotes its source and pins each quotation by byte span and SHA-256. When the text changes, someone has to find, rule by rule, what moved, what changed and what is new. `pnpm pack:compare <pack> <new text>` does the finding. It is ordinary code: the same pack and the same bytes always give the same report, and nothing calls a language model.

## What it says, and what it does not

For every rule it reports what the quoted words did: unchanged, unchanged but for spacing, changed, or not found. It never says that a rule still applies or no longer applies. Whether a rule's check still means what the new words say is a person's reading; the report gives them the old words, the new words and where they are.

## What is compared

The pack is a pack folder, a built pack file, or the id of a built-in pack.

- A folder is built in memory as `pnpm pack:build` builds it, and the comparison reads the pack file that makes. A folder that does not build is refused with the builder's own message.
- A built-in pack is read from its registered latest version, not from its TypeScript: each rule's source carries its quoted words, and a paragraph of a retained document carries its byte span in that document. The retained document itself is not needed, since the quoted words are all the comparison searches for.
- Purposes and required records, with the words that say how long a record is kept, are pinned quotations too. They are compared the same way and reported after the rules, with counts of their own.

The new text is read as bytes and never re-encoded. Exact search runs on the bytes, and every span reported is in bytes of the file as given, half-open like the spans a pack pins. Text that is not valid UTF-8 is refused: a pack's source is UTF-8, so nothing else could become one.

## Three steps

1. **The exact bytes.** Every place the pinned bytes occur.
2. **The words, spacing made uniform.** The quotation's words in order with any run of spaces and line breaks between them. This is exactly how the builder finds a quotation (`findQuotation`), including that the first word may end, and the last begin, a longer run of characters. So "unchanged but for spacing" means `pnpm pack:build` will find the quotation as the description writes it, and a test holds the two to the same span.
3. **The nearest passage.** Only when the first two find nothing.

Steps one and two are both run, and a quotation that is there byte for byte in one place and re-spaced in another is reported with both: the builder would find both, so a person has to say which is meant.

## The nearest passage

The measure is a local alignment of the quotation's words with the new text's words: 3 for each word matched in order, 1 off for each word passed over on either side, the best-scoring stretch taken. Words are compared exactly. The result is Changed when the stretch holds at least 60% of the quotation's words and Not found below that; the stretch is reported either way. Of equal scores the one that ends first in the text is kept.

Considered and not taken: the share of the quotation's words found in order in a passage (a longest common subsequence over words, passage by passage). It depends on how the text is cut. A short quotation finds most of its words, scattered, in any long passage, so long passages win over the right short one; and a quotation that spans several designated paragraphs, as 18 of the Part 108 pack's 95 rules do, matches no single passage well. The alignment needs no passages: passing over a word costs something, so the stretch stays about as long as the quotation, wherever it lies.

The weights are small whole numbers so the sentence in the report can state them. A matched word is worth more than two passed-over words so that one replaced word (one passed over on each side) does not end the stretch. The 60% line is a round figure, tried on the tests' editions and on the Part 108 notice with a few paragraphs reworded by hand; it is a line for sorting, not a judgment, and a short quotation reworded heavily can still land nearest to an unrelated passage. The report shows the words so a person sees that.

The alignment is quadratic in memory only for the stretch walked back, bounded by four times the quotation's length; a quotation of more than 4,000 words gets no nearest passage. Comparing the Part 108 pack with a 1.4 MB text takes a few seconds.

## Passages no rule quotes

In the other direction the new text is cut into passages and each one no rule's quotation lies in is listed. The cut is deliberately plain: at each line that begins with a paragraph designator, `(a)`, `(1)`, `§ 108.40` or `Sec. 108.40` as the Federal Register prints it, after any markup tags, when at least two lines begin so; otherwise at blank lines. The report says which was used and how many passages it made. Passages are used for this list only, never for the nearest passage.

## Moved

Offsets always shift, so "moved" cannot mean a different span. Among the quotations of one source found exactly once, the longest run that still reads in the old order is kept and each quotation outside it is marked. It needs the old position, which a pack file and a retained document give; a rule that carries its text whole has none and is never marked.

## The next version, and the marker

`--write-next <folder>` is for a pack folder. It writes the new text under the source's file name, byte for byte, and `pack.yaml` as it was, comments kept, with `version` raised by one. A quotation the new text holds exactly once, which the builder will find, is left as written. Every other one keeps its old `quote` and gains a `settle` field beside it:

```yaml
settle:
  result: changed # or not_found, more_than_once, occurrence_out_of_date
  was: the old quotation, spacing made uniform
  nearest: the lines of the new text nearest to it # when changed
  nearestLine: 17
  lines: [12, 40] # where it starts, when it is there more than once
```

`pnpm pack:build` refuses a description that holds any `settle`, before it looks for a single quotation, naming each item as the builder names it, with the old quotation and the nearest passage. The marker is data in the description, so it survives being copied or committed and cannot be missed; the refusal is in the builder, so no path builds a folder past it. Nothing is rewritten by guess: not the quotation, not an `occurrence`, not a parameter. A quotation found more than once is marked even when the description already gives an `occurrence`, because the count is from the old text.

## Not here

Fetching a new text from a publisher, and telling an organization that a text it adopted has been amended.
