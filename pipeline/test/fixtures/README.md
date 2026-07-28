Fixture trees for validate.test.ts. Broken on purpose; never loaded by the build.

`mame/` is different: it is a hand-built miniature `-listxml` document plus the extraction
policy and the two golden output files for it (mame-extract.test.ts). Its document order is
deliberately not its output order — machines out of sequence, device tags out of sequence,
clones before their parent, three-way ties in the worklist — so that any code which leaks a
Map or Set insertion order into an output produces different bytes than the golden files.
Regenerate the `*.expected.json` files only when the change to them is the point of the
commit, and read the diff.

This whole directory is in `.prettierignore`: reformatting it would repair the malformed
JSON some fixtures depend on, and would rewrite the golden files the byte comparison is
against.
