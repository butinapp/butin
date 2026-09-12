// Blocks a commit that would introduce personal data into the repo. Fixtures and samples are transcribed from real
// service recordings, so a real address, account number, or access code rides along into a file that reads as
// synthetic. Two layers, cheapest first:
//
//   1. Denylist — literal matches against `.pii-denylist` (gitignored; each developer fills in the values they know
//      appear in their own captures). Runs over EVERY scanned line. Deterministic, instant, and catches repeats.
//   2. Semantic — a headless Claude pass over added lines in fixture-shaped files, for what no pattern can describe:
//      a street address inside an HTML cell, a property roll number that is just twenty-three anonymous digits.
//
// Layer 1 blocks. Layer 2 blocks on findings but FAILS OPEN when the CLI is missing, offline, or slow — a hook that
// breaks commits on a plane gets disabled, and layer 1 still ran. pre-push re-scans the whole outgoing range, so a
// commit that slipped past layer 2 while offline gets a second look before it can leave the machine.
//
// Usage:
//   node scripts/pii-scan.mjs                    # scan the staged diff — what .githooks/pre-commit runs
//   node scripts/pii-scan.mjs --range <revs...>  # scan every commit in a range — what .githooks/pre-push runs
//   node scripts/pii-scan.mjs --all              # sweep every tracked file instead, for a one-off audit
//
// pre-commit is the cheap feedback loop; pre-push is the gate that matters. Once a commit reaches a remote it is
// public and permanent — a pull-request ref pins it even after the branch is deleted and the history force-pushed.
// So pre-push scans the whole outgoing range, including commits pre-commit never saw.
//
// Env:
//   BUTIN_SKIP_PII_SCAN=1   Skip entirely. `git commit --no-verify` bypasses it too.
//   BUTIN_PII_MODEL=name    Model for the semantic pass. Default: haiku.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const DENYLIST = '.pii-denylist'
const MODEL = process.env.BUTIN_PII_MODEL ?? 'haiku'
const TIMEOUT_MS = 90_000
const MAX_PAYLOAD = 60_000

// Added lines in these files get the semantic pass — everything a recording normally gets transcribed into.
const FIXTURE_SHAPED = /(\.test\.[jt]sx?$|(^|\/)sample\.ts$|\/fixtures?\/|\.fixture\.[jt]s$|\/recordings?\/)/
const TEXTUAL = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|html|txt|csv|ya?ml)$/
// A lockfile is package names plus integrity hashes; a short denylist term matches inside a hash by chance.
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/

const PROMPT = `You are a pre-commit privacy gate for a repository about to be published publicly. The lines below come from
test fixtures and sample data, which in this project are routinely transcribed from real recorded sessions of the
developer's OWN accounts. Real personal data therefore looks exactly like test data, and you cannot tell them apart by
plausibility. Judge by PROVENANCE instead: was this value drawn from the project's placeholder vocabulary, or is it an
arbitrary specific value of the kind a real capture produces?

SYNTHETIC — do not report. The project's documented placeholder vocabulary:
- anything at example.invalid, example.com, example.org, or localhost
- digits that are sequential (123456789), repeated (0000000001), or zero-padded placeholders (50-00000001)
- reserved test values: 555-01xx phone numbers, the H0H 0H0 postal code, card 4111 1111 1111 1111
- names that read as explicit stand-ins: Jane Doe, John Doe, Alex Tremblay, Marie-Claude Gagnon, Test User, FICTIVE
- company, vendor, and product names; public API hostnames; URL paths; HTTP header names; git shas
- identifiers carrying no personal linkage: plugin ids, column keys, seed strings, enum values
- ordinary code, types, comments, and imports

REPORT everything else that could identify a person or their account — even though it sits in a test file, and even
though you cannot prove it is real:
- a personal name that is not on the stand-in list above
- a street address, unit number, or postal code
- a phone number outside the reserved 555-01xx range
- an email address at a real domain
- government or utility identifiers: property roll/matricule numbers, dossier, policy, licence, SIN/SSN
- account, customer, host, invoice, or transaction ids that look arbitrary rather than placeholder-patterned
- session tokens, cookies, API keys, bearer tokens, passwords

Respond with ONLY a JSON object. No prose, no code fences:
{"findings":[{"file":"<path>","snippet":"<the offending value alone>","kind":"<address|name|account-id|email|phone|token|other>","why":"<one short clause>"}]}

The default is to REPORT. An arbitrary, specific, real-world-plausible value that is not drawn from the placeholder
vocabulary above IS a finding — that is precisely what a leaked capture looks like. An empty findings array means every
value present was recognisably synthetic.`

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const parseDiff = (diff) => {
  const added = []
  let file = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = LOCKFILE.test(line.slice(6)) ? null : line.slice(6)
    } else if (file && line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ file, text: line.slice(1) })
    }
  }

  return added
}

// Added lines only. Re-scanning whole files would re-flag settled content on every commit and make the gate noisy.
const stagedAdditions = () => parseDiff(git(['diff', '--cached', '-U0', '--diff-filter=ACM']))

// EVERY commit's own patch across the range, not the range's net diff. A commit that adds personal data and a later
// one that removes it cancel out in a net diff, so the net diff of a branch that was cleaned up at the tip reads
// clean while the data still sits in an ancestor — which is exactly what gets pinned forever once it is pushed.
const rangeAdditions = (revs) => parseDiff(git(['log', '-p', '-U0', '--no-merges', ...revs]))

const trackedLines = () =>
  git(['ls-files'])
    .split('\n')
    .filter((f) => f && TEXTUAL.test(f) && !LOCKFILE.test(f) && existsSync(f) && statSync(f).size < 2_000_000)
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((text) => ({ file, text }))
    )

const denylistTerms = () => {
  if (!existsSync(DENYLIST)) {
    return null
  }

  return readFileSync(DENYLIST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

const denylistFindings = (lines, terms) =>
  terms.flatMap((term) =>
    lines
      .filter(({ text }) => text.toLowerCase().includes(term.toLowerCase()))
      .map(({ file }) => ({ file, snippet: term, kind: 'denylist', why: `listed in ${DENYLIST}` }))
  )

const semanticFindings = (lines) => {
  if (!lines.length) {
    return { findings: [], skipped: null, truncated: false }
  }

  const whole = lines.map(({ file, text }) => `${file}: ${text}`).join('\n')
  const payload = whole.slice(0, MAX_PAYLOAD)
  const truncated = whole.length > MAX_PAYLOAD

  try {
    const out = execFileSync('claude', ['-p', '--model', MODEL], {
      input: `${PROMPT}\n\nADDED LINES:\n${payload}\n`,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      shell: true,
      maxBuffer: 8 * 1024 * 1024
    })
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)

    return { findings: JSON.parse(json).findings ?? [], skipped: null, truncated }
  } catch (err) {
    return { findings: [], skipped: (err.message ?? String(err)).split('\n')[0], truncated }
  }
}

const dedupe = (findings) => [...new Map(findings.map((f) => [`${f.file}::${f.snippet}`, f])).values()]

const collectLines = () => {
  const rangeAt = process.argv.indexOf('--range')

  if (rangeAt !== -1) {
    return rangeAdditions(process.argv.slice(rangeAt + 1))
  }

  return process.argv.includes('--all') ? trackedLines() : stagedAdditions()
}

const main = () => {
  if (process.env.BUTIN_SKIP_PII_SCAN === '1') {
    return
  }

  const lines = collectLines()

  if (!lines.length) {
    return
  }

  const terms = denylistTerms()
  const semantic = semanticFindings(lines.filter(({ file }) => FIXTURE_SHAPED.test(file)))
  const findings = dedupe([...denylistFindings(lines, terms ?? []), ...semantic.findings])

  if (terms === null) {
    console.warn(`  PII guard: no ${DENYLIST} — copy ${DENYLIST}.example and fill it in.`)
  }

  if (semantic.skipped) {
    console.warn(`  PII guard: semantic pass skipped (${semantic.skipped}). The denylist pass still ran.`)
  }

  if (semantic.truncated) {
    console.warn(
      `  PII guard: range too large to review at once — the semantic pass saw the first ${MAX_PAYLOAD} characters.`
    )
  }

  if (!findings.length) {
    return
  }

  console.error(`\n  PII guard: ${findings.length} finding(s) — commit blocked.\n`)

  for (const f of findings) {
    console.error(`    ${f.file}\n      ${f.kind.padEnd(12)} ${f.snippet}  — ${f.why}`)
  }

  console.error('\n  Replace these with synthetic values. If they are false positives:')
  console.error('    BUTIN_SKIP_PII_SCAN=1 git commit ...      (or: git commit --no-verify)\n')
  process.exit(1)
}

main()
