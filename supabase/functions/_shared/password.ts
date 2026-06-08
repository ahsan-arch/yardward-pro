// Shared cryptographically-secure random password generator for the auth-
// related edge functions (admin-create-user, admin-rotate-password, and any
// future caller that needs to mint a temp password).
//
// Design choices:
//
// 1. **Alphabet excludes ambiguous glyphs** — no 0/O, 1/l/I, etc. Operators
//    read these passwords out loud during handoff (and customers copy them
//    from SMS / email screens that may use bad fonts). The ambiguous
//    characters are the most-common transcription-error source we've seen
//    in support tickets.
//
// 2. **Includes a small symbol set** (!@#$%) to satisfy "must contain a
//    special character" rules at the application AND the Supabase Auth
//    backend layer. We avoid `&`, `'`, `"`, `\`, `<`, `>`, ` ` because they
//    break URL/JSON/HTML escaping if the operator copies into the wrong
//    surface.
//
// 3. **Rejection sampling** instead of plain `byte % alpha.length`. Naive
//    modulo introduces a bias proportional to `256 % alpha.length` — for
//    our 59-char alphabet, the first 20 chars are ~25% more likely than
//    the rest. Rejection sampling keeps the distribution uniform at the
//    cost of occasionally drawing an extra byte (worst case ~5% overhead).
//    For a 16-char password we use Web Crypto's getRandomValues to fill a
//    larger buffer up-front so we don't loop one byte at a time.

const SAFE_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

export function generatePassword(length = 16): string {
  if (length < 8) {
    // Refuse to generate something the Supabase Auth backend will reject —
    // catching the bug here is more useful than a confusing 422 later.
    throw new Error(`generatePassword: length must be >= 8 (got ${length})`);
  }
  const alphaLen = SAFE_ALPHABET.length;
  // Largest multiple of alphaLen that fits in a byte. Any random byte >=
  // this value is discarded — that's the rejection step that keeps the
  // distribution uniform.
  const cutoff = 256 - (256 % alphaLen);
  let out = "";
  // Draw 32 bytes at a time; refill as we burn through them. Each refill
  // is one syscall, so amortizing across multiple chars is cheaper.
  const buf = new Uint8Array(32);
  let cursor = buf.length; // force refill on first iteration
  while (out.length < length) {
    if (cursor >= buf.length) {
      crypto.getRandomValues(buf);
      cursor = 0;
    }
    const b = buf[cursor++];
    if (b < cutoff) {
      out += SAFE_ALPHABET[b % alphaLen];
    }
    // Otherwise: discard this byte and try the next.
  }
  return out;
}
