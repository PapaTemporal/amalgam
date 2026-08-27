/**
 * Matching words when there is no model to match meaning with.
 *
 * This is the path a machine gets with nothing downloaded, and it used to
 * answer nothing at all: twelve questions phrased by intent, zero of them
 * found. The reason was not that words are hopeless — it was that almost
 * nothing was being matched against. A symbol was compared on its identifier
 * and its path, so `verifyFact` could only be found by somebody who already
 * knew to type "verify" or "fact", which is precisely the knowledge the search
 * exists to supply.
 *
 * Three things are wrong with comparing raw identifiers, and all three are
 * cheap to fix:
 *
 *   `placeOrder` is two words, and asking for "order" should reach it.
 *   "memories" and "memory" are the same word to everyone except a computer.
 *   The sentence explaining what a function is FOR is the part written in the
 *   language people ask questions in — and it was being ignored.
 *
 * What this cannot do is bridge vocabulary. "Where is authentication handled"
 * will not reach `validateSession` unless one of them says the other's words
 * somewhere. That gap is what the embedding model exists to close, and no
 * amount of stemming substitutes for it. The aim here is only to stop losing
 * the questions that a careful reader WOULD have answered from the text
 * already present.
 */

/**
 * Words that appear in questions rather than in answers.
 *
 * Dropped because they match everything and therefore rank nothing: a query
 * keeping "how", "does" and "which" spends its weight on whichever symbol
 * happens to contain those letters.
 *
 * Function words only. The temptation is to add the words that feel generic in
 * a codebase — file, value, code, get — and that is a mistake: they are the
 * content words of identifiers, and dropping them means "stale files" cannot
 * find `staleFiles`. A stopword list that grows starts deleting the question.
 */
const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "our", "its",
  "how", "what", "where", "when", "which", "who", "why", "does", "did",
  "was", "were", "has", "have", "had", "can", "will", "would", "should",
  "this", "that", "these", "those", "there", "here", "then", "than",
  "with", "from", "into", "onto", "over", "under", "about", "after", "before",
  "any", "all", "one", "two", "some", "each", "every", "both", "other",
  "actually", "really", "just", "only", "also", "still",
]);

/**
 * Reduce a word to something two spellings of it agree on.
 *
 * Not a real stemmer — a real one needs a dictionary and gets "memories" wrong
 * in a different way. This trims the endings that separate a question from an
 * identifier ("writes"/"written", "memories"/"memory") and stops. Over-trimming
 * is safe here because both sides are trimmed the same way: the worst case is
 * two unrelated words colliding, which costs one bad candidate, while
 * under-trimming costs the answer entirely.
 */
export function stem(word) {
  let w = word;

  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";

  // "-es" is only a plural after a sibilant: matches -> match, boxes -> box.
  // Everywhere else the "e" belongs to the word, and stripping it turns
  // "files" into "fil", which then matches nothing at all.
  if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);

  // A suffix is only worth removing if a word is left behind. "importing"
  // becomes "import", but "thing" must not become "th" — a two-letter stem
  // matches half the codebase.
  if (w.length >= 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length >= 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);

  // English drops the "e" before "-ing": slice/slicing, place/placing. Trimming
  // it from both sides is what lets one meet the other.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);

  return w;
}


/**
 * Split anything — a sentence, an identifier, a path — into comparable words.
 *
 * camelCase, snake_case, kebab-case and dotted names all become their parts,
 * so `verifyFact`, `verify_fact` and "verify the fact" arrive at the same two
 * tokens.
 */
export function tokens(text, { keepStop = false } = {}) {
  if (!text) return [];
  const out = [];
  // Split on non-alphanumerics first, then on case boundaries inside each run.
  for (const chunk of String(text).split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    for (const part of chunk.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
                            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
                            .split(" ")) {
      const w = part.toLowerCase();
      if (w.length < 3) continue;                 // "id", "db", "fs" match everything
      if (!keepStop && STOP.has(w)) continue;
      out.push(stem(w));
    }
  }
  return out;
}

/** The distinct words a question is actually asking about. */
export const queryTerms = (task) => [...new Set(tokens(task))];

/**
 * How well one symbol answers a set of query words.
 *
 * Each field is worth what it is worth as evidence. An identifier that IS the
 * word is the strongest signal there is; a doc comment saying so is the next,
 * because it is the field written in the language questions are asked in; a
 * path is the weakest, since every file in a directory shares it.
 *
 * Scored per distinct term rather than per occurrence, so a symbol cannot win
 * by repeating one word — then multiplied by how much of the question it
 * covers, because matching three of four words is a different kind of answer
 * from matching one word three times.
 */
export function lexicalScore(terms, { name = "", file = "", signature = "", doc = "", context = "" } = {}) {
  if (!terms.length) return 0;

  const fields = [
    [new Set(tokens(name)), 8],
    [new Set(tokens(signature)), 2.5],
    [new Set(tokens(doc)), 3],
    [new Set(tokens(context)), 1.2],
    [new Set(tokens(file)), 1],
  ];

  let sum = 0;
  let matched = 0;
  for (const t of terms) {
    let best = 0;
    for (const [words, weight] of fields) if (words.has(t) && weight > best) best = weight;
    if (best > 0) { sum += best; matched++; }
  }
  if (!matched) return 0;

  // Coverage matters more than depth: half the question answered is a real
  // candidate, one word answered five times over is usually a coincidence.
  return sum * (1 + (matched / terms.length));
}
